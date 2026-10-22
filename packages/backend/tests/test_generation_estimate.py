"""The run-time estimate's pure parts: the ladder, the load cost, the plan
over a queue, and reading a cold start from ComfyUI's history."""

from __future__ import annotations

import pytest

from moire.services.generation_estimate import (
    Job,
    Run,
    load_cost,
    plan,
    warm_estimate,
)
from moire.services.generation_estimate import _job, _run_order
from moire.services.generation_jobs import batch_shape, model_loaded

PX = 832 * 1216


def run(seconds, *, cold=None, **job_args):
    return Run(job(**job_args), seconds, cold)


def job(*, ckpt="a", pixels=PX, steps=28, images=1, gen="g"):
    return Job(gen, ckpt, pixels, steps, images)


def test_exact_matches_take_the_median_and_skip_cold_starts():
    runs = [run(10), run(12), run(40, cold=True), run(11), run(99, steps=50)]
    e = warm_estimate(runs, job())
    assert (e.seconds, e.basis, e.samples) == (11, "exact", 3)


def test_only_the_latest_exact_runs_count():
    runs = [run(20)] * 10 + [run(5)] * 10
    assert warm_estimate(runs, job()).seconds == 20


def test_other_sizes_scale_by_work_on_the_same_checkpoint():
    # 28 steps took 10s; 56 steps on twice the pixels is four times the work.
    runs = [run(10), run(30, ckpt="b")]
    e = warm_estimate(runs, job(steps=56, pixels=PX * 2))
    assert e.basis == "checkpoint" and e.seconds == pytest.approx(40)


def test_a_new_checkpoint_falls_back_to_the_generator():
    runs = [run(10), run(20, ckpt="b"), run(30, ckpt="c"), run(1, gen="other")]
    e = warm_estimate(runs, job(ckpt="d", images=2))
    assert e.basis == "generator" and e.seconds == pytest.approx(40)


def test_no_history_or_no_size_is_no_estimate():
    assert warm_estimate([], job()) is None
    assert warm_estimate([run(10, gen="other")], job()) is None
    assert warm_estimate([run(10)], job(pixels=None)) is None


def test_load_cost_is_what_cold_runs_took_beyond_warm():
    runs = [
        run(10),
        run(10),
        run(25, cold=True),
        run(30, ckpt="b"),
        run(45, ckpt="b", cold=True),
    ]
    assert load_cost(runs, "a") == 15
    assert load_cost(runs, "b") == 15
    # A checkpoint never loaded: any checkpoint's cold starts.
    assert load_cost(runs, "c") == 15
    assert load_cost([run(10)], "a") is None


def test_plan_adds_a_load_only_when_the_checkpoint_changes():
    runs = [run(10), run(20, ckpt="b"), run(35, ckpt="b", cold=True)]
    jobs = [job(), job(ckpt="b"), job(ckpt="b"), job(gen="other")]
    assert plan(runs, jobs, loaded="a") == [10, 35, 20, None]
    # Nothing known loaded: no switch to count.
    assert plan(runs, [job()], loaded=None) == [10]


def test_a_checkpoint_loader_that_ran_is_a_cold_start():
    def entry(*cached):
        return {
            "status": {
                "messages": [
                    ["execution_start", {}],
                    ["execution_cached", {"nodes": list(cached)}],
                ]
            }
        }

    assert model_loaded(entry("1", "2"), "4") is True
    assert model_loaded(entry("4", "7"), "4") is False
    assert model_loaded(entry("4"), 4) is False
    assert model_loaded({"status": {"messages": []}}, "4") is None
    assert model_loaded(entry("4"), None) is None


def test_images_per_request():
    builtin = {"kind": "builtin", "slots": {"batch_size": ["5", "batch_size"]}}
    custom = {"kind": "custom", "slots": {"batch_size": ["5", "x"], "per_request": 3}}

    def per(gen, body, settings=None):
        shape = batch_shape(gen, body, settings or {})
        return shape["per_request"], shape["per_request_asked"]

    assert per(builtin, {"per_request": 4}) == (4, 4)
    assert per(builtin, {"per_request": 200}) == (64, 64)
    assert per(builtin, {}, {"builtin_per_request": 2}) == (2, None)
    # A size asked for one batch applies to a custom Generator too.
    assert per(custom, {"per_request": 4}) == (4, 4)
    assert per(custom, {}) == (3, None)
    # Mapped by hand with no size: one image a run, as Generate shows it.
    hand = {"kind": "custom", "slots": {"batch_size": ["5", "x"]}}
    assert per(hand, {}) == (1, None)
    assert per({"kind": "custom", "slots": {}}, {"per_request": 4}) == (None, None)


def test_checkpoint_only_where_the_graph_has_a_slot():
    body = {"checkpoint": "a.safetensors"}
    with_slot = {"kind": "custom", "slots": {"checkpoint": ["4", "ckpt_name"]}}
    without = {"kind": "custom", "slots": {}}
    assert batch_shape(with_slot, body, {})["checkpoint"] == "a.safetensors"
    assert batch_shape(without, body, {})["checkpoint"] is None


def test_what_a_batch_leaves_unset_is_the_graphs_own():
    gen = {
        "graph": {
            "4": {"inputs": {"ckpt_name": "base.safetensors"}},
            "5": {"inputs": {"width": 1024, "height": 1024}},
            "3": {"inputs": {"steps": 20}},
        },
        "slots": {
            "checkpoint": ["4", "ckpt_name"],
            "width": ["5", "width"],
            "height": ["5", "height"],
            "steps": ["3", "steps"],
        },
    }
    assert _job(gen, "g", {}, None) == Job("g", "base.safetensors", 1024 * 1024, 20, 1)
    asked = {"checkpoint": "x", "width": 832, "height": 1216, "sampling": {"steps": 28}}
    assert _job(gen, "g", asked, 2) == Job("g", "x", PX, 28, 2)
    # A link (another node's output) isn't a value.
    gen["graph"]["3"]["inputs"]["steps"] = ["9", 0]
    assert _job(gen, "g", {}, None).steps is None


def test_pending_requests_run_batch_after_batch():
    from types import SimpleNamespace as Row

    rows = [
        Row(state="running", batch_id=2, idx=0, inputs={}),
        Row(state="pending", batch_id=1, idx=1, inputs={}),
        Row(state="pending", batch_id=1, idx=2, inputs={}),
        Row(state="pending", batch_id=2, idx=1, inputs={}),
        Row(state="pending", batch_id=2, idx=2, inputs={}),
        Row(state="pending", batch_id=3, idx=0, inputs={"test": True}),
    ]
    got = [(r.batch_id, r.idx) for r in _run_order(rows)]
    # A test run first, then the rest of the batch being made, then the oldest.
    assert got == [(2, 0), (3, 0), (2, 1), (2, 2), (1, 1), (1, 2)]
