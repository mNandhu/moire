"""AI job worker: inference must run off the event loop, and the next image's
read + decode must overlap the current inference."""

import asyncio
import time
import pytest

from PIL import Image

from moire.services import activity
from moire.services.ai import jobs as ai_jobs
from moire.services.ai.jobs import AIJob, AIJobManager
from moire.services.ai.tagger import TagParams, TaggerManager

_RESULT = {"caption": "", "rating": {}, "general_tags": [], "character_tags": []}

_PREDICT_KW = dict(
    model_repo="r",
    cache_dir="/c",
    params=TagParams(),
)


async def test_predict_image_does_not_block_event_loop(monkeypatch):
    mgr = TaggerManager()

    async def fake_ensure_loaded(*, model_repo: str, cache_dir: str) -> None:
        return None

    def slow_predict(**_kw):
        time.sleep(0.3)  # a blocking ONNX run
        return _RESULT

    monkeypatch.setattr(mgr, "ensure_loaded", fake_ensure_loaded)
    monkeypatch.setattr(mgr._tagger, "predict", slow_predict)

    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    tick_task = asyncio.create_task(ticker())
    try:
        out = await mgr.predict_image(image=Image.new("RGBA", (4, 4)), **_PREDICT_KW)
    finally:
        tick_task.cancel()
    assert out is _RESULT
    # A blocked loop would tick ~0 times during the 0.3s run.
    assert ticks >= 10


def _job_manager(
    monkeypatch, events: list[str], *, fail_load: frozenset[str] = frozenset()
):
    mgr = AIJobManager()

    async def fake_load(image_id: str):
        events.append(f"load-start:{image_id}")
        await asyncio.sleep(0.01)
        if image_id in fail_load:
            raise RuntimeError("unreadable")
        events.append(f"load-end:{image_id}")
        return Image.new("RGBA", (4, 4))

    async def fake_tag_one(*, image_id: str, image, settings, model, bulk):
        events.append(f"tag-start:{image_id}")
        await asyncio.sleep(0.05)
        events.append(f"tag-end:{image_id}")

    async def fake_settings():
        return {}

    async def model_ready(job, repo, cache_dir):
        return True

    monkeypatch.setattr(mgr, "_load_image", fake_load)
    monkeypatch.setattr(mgr, "_tag_one", fake_tag_one)
    monkeypatch.setattr(mgr, "_prepare_model", model_ready)
    monkeypatch.setattr(ai_jobs, "get_ai_settings", fake_settings)
    return mgr


async def _run(mgr: AIJobManager, ids: list[str]):
    worker = asyncio.create_task(mgr._worker_loop())
    job = await mgr.enqueue(ids=ids)
    try:
        for _ in range(500):
            if job.status in ("done", "error", "cancelled"):
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()
    return job


async def test_worker_prefetches_next_image_during_inference(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    job = await _run(mgr, ["a", "b", "c"])

    assert job.status == "done" and job.done == 3
    # b's load starts before a's inference finishes.
    assert events.index("load-start:b") < events.index("tag-end:a")
    assert events.index("load-start:c") < events.index("tag-end:b")


async def test_worker_counts_failed_load_and_continues(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events, fail_load={"b"})
    job = await _run(mgr, ["a", "b", "c"])

    assert job.status == "error"
    assert (job.done, job.failed) == (2, 1)
    assert job.errors[0]["image_id"] == "b"
    assert "tag-start:b" not in events


async def test_cancel_drops_the_prefetch(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    worker = asyncio.create_task(mgr._worker_loop())
    job = await mgr.enqueue(ids=["a", "b", "c"])
    try:
        while "tag-start:a" not in events:
            await asyncio.sleep(0.005)
        await mgr.cancel(job.id)
        for _ in range(100):
            if job.status == "cancelled":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()

    assert job.status == "cancelled" and job.done == 1
    assert "tag-start:b" not in events
    assert not mgr._in_flight


async def test_cancelled_predict_holds_the_lock_until_inference_ends(monkeypatch):
    """The ONNX thread can't be cancelled: until it ends, nothing else may
    take the lock (an unload would pull the session out from under it)."""
    mgr = TaggerManager()
    finished = []

    async def fake_ensure_loaded(*, model_repo: str, cache_dir: str) -> None:
        return None

    def slow_predict(**_kw):
        time.sleep(0.3)
        finished.append(time.monotonic())
        return _RESULT

    monkeypatch.setattr(mgr, "ensure_loaded", fake_ensure_loaded)
    monkeypatch.setattr(mgr._tagger, "predict", slow_predict)

    task = asyncio.create_task(
        mgr.predict_image(image=Image.new("RGBA", (4, 4)), **_PREDICT_KW)
    )
    await asyncio.sleep(0.05)
    task.cancel()
    async with mgr._lock:
        acquired = time.monotonic()
    assert finished and acquired >= finished[0]
    assert task.cancelled()


class _SlowLoader:
    """A tagger whose model takes ``delay`` to arrive, or never does."""

    def __init__(self, delay: float, error: str | None = None):
        self.delay, self.error, self.loaded = delay, error, False
        self.started = 0

    def status(self):
        return {"loaded": self.loaded, "repo": "r" if self.loaded else None}

    def start_load(self, **_kw):
        self.started += 1

    async def ensure_loaded(self, **_kw):
        await asyncio.sleep(self.delay)
        if self.error:
            raise RuntimeError(self.error)
        self.loaded = True

    def set_idle_unload_s(self, _s):
        pass


async def test_job_waits_on_the_model_in_its_own_phase(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    monkeypatch.setattr(mgr, "_prepare_model", AIJobManager._prepare_model.__get__(mgr))
    loader = _SlowLoader(0.2)
    monkeypatch.setattr(ai_jobs, "get_tagger_manager", lambda: loader)
    worker = asyncio.create_task(mgr._worker_loop())
    job = await mgr.enqueue(ids=["a"])
    try:
        await asyncio.sleep(0.05)
        assert (job.status, job.phase) == ("running", "model")
        assert loader.started == 1  # through the shared load: it shows as progress
        for _ in range(100):
            if job.status == "done":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()
    assert (job.status, job.phase, job.done) == ("done", "tagging", 1)


async def test_a_model_that_fails_to_load_fails_the_job_once(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    monkeypatch.setattr(mgr, "_prepare_model", AIJobManager._prepare_model.__get__(mgr))
    monkeypatch.setattr(
        ai_jobs, "get_tagger_manager", lambda: _SlowLoader(0.01, "no network")
    )
    job = await _run(mgr, ["a", "b"])
    assert (job.status, job.error, job.failed) == ("error", "no network", 2)
    assert not events  # no image was read
    assert not mgr._in_flight


async def test_cancel_while_the_model_loads(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    monkeypatch.setattr(mgr, "_prepare_model", AIJobManager._prepare_model.__get__(mgr))
    monkeypatch.setattr(ai_jobs, "get_tagger_manager", lambda: _SlowLoader(5))
    worker = asyncio.create_task(mgr._worker_loop())
    job = await mgr.enqueue(ids=["a"])
    try:
        await asyncio.sleep(0.05)
        await mgr.cancel(job.id)
        for _ in range(200):
            if job.status == "cancelled":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()
    assert job.status == "cancelled" and not events


async def test_a_cancelled_model_load_fails_the_job_not_the_worker(monkeypatch):
    events: list[str] = []
    ended_before = activity.ended().get("ai_job", 0)
    mgr = _job_manager(monkeypatch, events)
    monkeypatch.setattr(mgr, "_prepare_model", AIJobManager._prepare_model.__get__(mgr))

    class _Cancelled(_SlowLoader):
        async def ensure_loaded(self, **_kw):
            await asyncio.sleep(0.01)
            raise asyncio.CancelledError  # the shared load, cancelled

    monkeypatch.setattr(ai_jobs, "get_tagger_manager", lambda: _Cancelled(0))
    first = await _run(mgr, ["a"])
    assert (first.status, first.error) == ("error", "The model load was cancelled")
    # The worker lived on: a later job still runs.
    monkeypatch.setattr(ai_jobs, "get_tagger_manager", lambda: _SlowLoader(0))
    second = await _run(mgr, ["b"])
    assert second.status == "done"
    assert activity.ended().get("ai_job", 0) == ended_before + 2


async def test_active_jobs_lists_every_unfinished_job_oldest_first():
    mgr = AIJobManager()
    jobs = [await mgr.enqueue(ids=[f"i{n}"]) for n in range(25)]
    active = mgr.active_jobs()
    assert len(active) == 25 and active[0] is jobs[0]


def test_throughput_while_running_and_after():
    job = ai_jobs.AIJob(id="j", created_at=0, total=10, status="running")
    assert job.throughput(now=5) == {}  # not started
    job.started_at = 100
    assert job.throughput(now=104) == {}  # nothing through yet
    job.done, job.failed = 3, 1
    assert job.throughput(now=104) == {"rate": 1.0, "elapsed_s": 4.0, "eta_s": 6.0}
    job.status = "cancelling"
    assert "eta_s" not in job.throughput(now=104)
    job.done, job.finished_at = 9, 105
    assert job.throughput(now=999) == {"rate": 2.0, "elapsed_s": 5.0}


async def test_a_finished_job_reports_its_rate(monkeypatch):
    mgr = _job_manager(monkeypatch, [])
    job = await _run(mgr, ["a", "b"])
    view = job.public()
    assert job.finished_at >= job.started_at
    assert view["rate"] > 0 and "eta_s" not in view


async def test_a_tagged_image_is_released_before_its_job_ends(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    worker = asyncio.create_task(mgr._worker_loop())
    job = await mgr.enqueue(ids=["a", "b", "c"])
    try:
        while "tag-start:b" not in events:
            await asyncio.sleep(0.005)
        # `a` is tagged while the job is still running: a new job takes it.
        again = await mgr.enqueue(ids=["a", "c"])
        assert (again.total, again.skipped) == (1, 1)
        for _ in range(200):
            if again.status == "done":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()
    assert job.status == "done" and again.status == "done"
    assert not mgr._in_flight


async def test_overlapping_claims_are_counted():
    mgr = AIJobManager()  # no worker: both jobs stay queued
    first = await mgr.enqueue(ids=["x"])
    forced = await mgr.enqueue(ids=["x"], force=True)
    await mgr.cancel(forced.id)
    # The first job still holds `x`.
    assert (await mgr.enqueue(ids=["x"])).skipped == 1
    await mgr.cancel(first.id)
    assert not mgr._in_flight


async def test_a_job_error_outside_the_images_does_not_stop_the_worker(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    calls = 0

    async def flaky_settings():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database is locked")
        return {}

    monkeypatch.setattr(ai_jobs, "get_ai_settings", flaky_settings)
    worker = asyncio.create_task(mgr._worker_loop())
    first = await mgr.enqueue(ids=["a"])
    second = await mgr.enqueue(ids=["b"])
    try:
        for _ in range(200):
            if second.status == "done":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()
    assert first.status == "error" and "locked" in first.error
    assert first.failed == 1
    assert second.status == "done"
    assert not mgr._in_flight


async def test_ended_jobs_are_pruned_but_active_ones_kept(monkeypatch):
    mgr = _job_manager(monkeypatch, [])
    monkeypatch.setattr(ai_jobs, "_KEEP_FINISHED", 3)
    for n in range(5):
        # force: no claim held, so each job is accepted, and nothing runs
        # (no worker), so they stay queued: all active, none pruned.
        await mgr.enqueue(ids=[f"q{n}"], force=True)
    assert len(mgr._jobs) == 5
    for j in mgr._jobs.values():
        j.status = "done"
    queued = await mgr.enqueue(ids=["last"], force=True)
    assert queued.id in mgr._jobs
    assert len(mgr._jobs) == 4  # 3 newest ended + the new one


async def test_a_just_ended_job_outlives_the_cap(monkeypatch):
    # A client may still be polling it for its final status.
    mgr = _job_manager(monkeypatch, [])
    monkeypatch.setattr(ai_jobs, "_KEEP_FINISHED", 1)
    for n in range(3):
        await mgr.enqueue(ids=[f"q{n}"], force=True)
    old, recent, newest = sorted(mgr._jobs.values(), key=lambda j: j.created_at)
    for j in (old, recent, newest):
        j.status = "done"
    old.finished_at = time.time() - ai_jobs._KEEP_RECENT_S - 1
    recent.finished_at = time.time()
    await mgr.enqueue(ids=["last"], force=True)
    assert old.id not in mgr._jobs
    assert recent.id in mgr._jobs


async def test_public_view_leaves_out_the_work_list(monkeypatch):
    mgr = _job_manager(monkeypatch, [])
    job = await mgr.enqueue(ids=["a", "b"])
    assert job.image_ids() == ["a", "b"]
    assert "ids" not in job.public()


async def test_stop_cancels_the_worker(monkeypatch):
    mgr = _job_manager(monkeypatch, [])
    mgr.start()
    worker = mgr._worker_task
    await mgr.stop()
    assert worker.cancelled() and mgr._worker_task is None


def test_activity_item_names_a_run_for_the_unknown_images():
    """The gallery banner follows only the job its "Tag them" queued."""
    job = AIJob(id="j", created_at=0.0, total=3, scope="unknown", ids=["a", "b", "c"])
    assert job.activity_item()["scope"] == "unknown"
    assert "scope" not in AIJob(id="k", created_at=0.0, total=3).activity_item()


async def test_a_job_already_tagging_hidden_images_takes_their_scope():
    """A "Tag them" whose images another job holds queues nothing: that job
    answers to it, so the hidden-images banner follows its progress."""
    mgr = AIJobManager()  # no worker: the first job stays queued
    library = await mgr.enqueue(ids=["a", "b", "c"])
    other = await mgr.enqueue(ids=["x"])
    hidden = await mgr.enqueue(ids=["b"], scope="unknown")
    assert hidden.total == 0 and hidden.skipped == 1
    assert library.scope == "unknown"
    assert other.scope is None


def test_only_runs_that_may_show_images_count_as_bulk():
    def ends(job: AIJob) -> int:
        before = activity.ended().get("ai_job_bulk", 0)
        ai_jobs._note_end(job)
        return activity.ended().get("ai_job_bulk", 0) - before

    assert ends(AIJob(id="one", created_at=0.0, total=1)) == 0
    assert ends(AIJob(id="many", created_at=0.0, total=40)) == 1
    assert ends(AIJob(id="h", created_at=0.0, total=1, scope="unknown")) == 1


async def test_an_urgent_job_runs_between_the_images_of_a_long_one(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    worker = asyncio.create_task(mgr._worker_loop())
    bulk = await mgr.enqueue(ids=[f"b{i}" for i in range(6)])
    try:
        while "tag-start:b1" not in events:
            await asyncio.sleep(0.005)
        one = await mgr.enqueue(ids=["mine"], urgent=True)
        for _ in range(500):
            if bulk.status == "done":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()

    assert one.status == "done" and bulk.status == "done" and bulk.done == 6
    # The re-tag didn't wait for the run to end.
    assert events.index("tag-end:mine") < events.index("tag-start:b5")
    assert not mgr._in_flight


async def test_an_image_the_tagger_finds_nothing_in_is_left_to_auto_tag(monkeypatch):
    mgr = _job_manager(monkeypatch, [], fail_load={"bad"})

    async def nothing_for_empty(*, image_id, image, settings, model, bulk):
        return image_id != "empty"

    monkeypatch.setattr(mgr, "_tag_one", nothing_for_empty)
    flushed: list[set[str]] = []

    async def flush():
        flushed.append(set(mgr._skip_new))

    monkeypatch.setattr(mgr, "_flush_skip", flush)
    await _run(mgr, ["ok", "empty", "bad"])
    assert flushed == [{"empty", "bad"}]


async def test_tag_them_takes_over_an_auto_tag_job_holding_its_images():
    mgr = AIJobManager()  # no worker: the auto job stays queued
    auto = await mgr.enqueue(ids=["a", "b"], scope="auto")
    again = await mgr.enqueue(ids=["a"], scope="unknown")
    assert again.total == 0 and again.skipped == 1
    # The hidden-images banner follows the job doing its work.
    assert auto.scope == "unknown"


async def test_an_urgent_job_takes_over_images_a_long_run_holds(monkeypatch):
    """Tag on a selection the auto run holds tags them now, not when the run
    gets there; the run then skips them instead of tagging them twice."""
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    worker = asyncio.create_task(mgr._worker_loop())
    bulk = await mgr.enqueue(
        ids=[f"b{i}" for i in range(6)], scope="auto", backlog=True
    )
    try:
        while "tag-start:b1" not in events:
            await asyncio.sleep(0.005)
        picked = await mgr.enqueue(ids=["b4"], urgent=True)
        assert picked.total == 1 and picked.skipped == 0
        for _ in range(500):
            if bulk.status == "done":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()

    assert picked.status == "done" and bulk.status == "done"
    assert events.count("tag-start:b4") == 1
    assert events.index("tag-end:b4") < events.index("tag-start:b3")
    assert bulk.done == 6 and not mgr._in_flight and not mgr._taken


async def test_a_nudge_during_an_auto_tag_pass_runs_one_more(monkeypatch):
    mgr = AIJobManager()
    mgr._loop = asyncio.get_running_loop()
    monkeypatch.setattr(ai_jobs, "_AUTO_DELAY_S", 0.0)
    passes = 0

    async def slow_pass():
        nonlocal passes
        passes += 1
        if passes == 1:
            mgr._schedule_auto()  # a file arrived mid-query
        await asyncio.sleep(0.01)

    monkeypatch.setattr(mgr, "auto_tag", slow_pass)
    mgr._schedule_auto()
    await mgr._auto_task
    assert passes == 2


async def test_the_recorded_rate_leaves_out_failures_and_urgent_jobs(monkeypatch):
    recorded: list[tuple[float, int]] = []

    async def record(device, rate, images):
        recorded.append((rate, images))

    monkeypatch.setattr(ai_jobs.ai_estimate, "record", record)
    monkeypatch.setattr(ai_jobs.ai_estimate, "current_device", lambda: "cpu")
    mgr = _job_manager(monkeypatch, [], fail_load=frozenset({"bad"}))
    job = await mgr.enqueue(ids=["a", "b", "bad"])
    job.nested_s = 0.0
    await mgr._run_job(job)
    ((rate, images),) = recorded
    assert images == 2
    assert rate == pytest.approx(2 / (job.finished_at - job.started_at))
