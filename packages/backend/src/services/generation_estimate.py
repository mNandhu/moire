"""How long a generation should take, from how long the same kind of work
took before.

Every finished request records the seconds ComfyUI spent on it
(``generation_run_times``, queue wait not counted) and whether it had to load
its checkpoint (``generation_run_loads``). An estimate for new work reads
those runs back, newest first:

1. the same Generator, checkpoint, steps, pixels (``width x height``, so
   832x1216 and 1216x832 are the same work) and images per request: the
   median of the last :data:`EXACT_RUNS`;
2. else the same Generator and checkpoint: the median seconds per *unit of
   work* (``pixels x steps x images``), times this job's work;
3. else the same Generator on any checkpoint, the same way;
4. else no estimate.

Medians, not means: one slow run (a cold start, ComfyUI busy with something
else) shouldn't move it. Sampler and scheduler are left out of the key: they
barely change the speed and would split the history into tiny groups.

Loading a checkpoint is counted apart. Runs where ComfyUI read the model from
disk (cold) are left out of the steps above; their extra time over the warm
estimate is the *load cost*, added when the work switches checkpoint from
the one that ran last. Pure functions, then the async readers.
"""

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn
from .generator_graph import sampling_defaults, split_requests

EXACT_RUNS = 10
SCALED_RUNS = 20
# Runs read back for an estimate, newest first.
HISTORY = 400


@dataclass(frozen=True)
class Run:
    """One finished request, as the estimate sees it."""

    generator: str
    checkpoint: str | None
    pixels: int | None
    steps: int | None
    images: int
    seconds: float
    cold: bool | None = None

    @property
    def work(self) -> float | None:
        if not self.pixels or not self.steps:
            return None
        return self.pixels * self.steps * self.images


@dataclass(frozen=True)
class Job:
    """One request to estimate."""

    generator: str
    checkpoint: str | None
    pixels: int | None
    steps: int | None
    images: int

    @property
    def work(self) -> float | None:
        if not self.pixels or not self.steps:
            return None
        return self.pixels * self.steps * self.images


@dataclass(frozen=True)
class Estimate:
    seconds: float
    # "exact" / "checkpoint" / "generator": which step of the ladder answered.
    basis: str
    samples: int


def warm_estimate(runs: list[Run], job: Job) -> Estimate | None:
    """The warm (model already loaded) seconds for ``job`` from ``runs``
    (newest first), by the ladder in the module docstring. Pure."""
    warm = [r for r in runs if r.cold is not True and r.generator == job.generator]
    exact = [
        r.seconds
        for r in warm
        if r.checkpoint == job.checkpoint
        and r.pixels == job.pixels
        and r.steps == job.steps
        and r.images == job.images
    ][:EXACT_RUNS]
    if exact:
        return Estimate(statistics.median(exact), "exact", len(exact))
    work = job.work
    if work is None:
        return None
    for basis, pool in (
        ("checkpoint", [r for r in warm if r.checkpoint == job.checkpoint]),
        ("generator", warm),
    ):
        rates = [r.seconds / r.work for r in pool if r.work][:SCALED_RUNS]
        if rates:
            return Estimate(statistics.median(rates) * work, basis, len(rates))
    return None


def load_cost(runs: list[Run], checkpoint: str | None) -> float | None:
    """Seconds a checkpoint switch adds: the median of what cold runs took
    beyond their warm estimate, for ``checkpoint`` when it has cold runs,
    else for any. ``None`` with no cold run to go on. Pure."""
    extra: dict[str | None, list[float]] = {}
    for r in runs:
        if r.cold is not True:
            continue
        # Cold runs are left out of the warm estimate already.
        warm = warm_estimate(runs, _job_of(r))
        if warm is not None:
            extra.setdefault(r.checkpoint, []).append(
                max(0.0, r.seconds - warm.seconds)
            )
    mine = extra.get(checkpoint)
    every = [x for xs in extra.values() for x in xs]
    pick = mine or every
    return statistics.median(pick) if pick else None


def _job_of(r: Run) -> Job:
    return Job(r.generator, r.checkpoint, r.pixels, r.steps, r.images)


def plan(runs: list[Run], jobs: list[Job], loaded: str | None) -> list[float | None]:
    """Seconds for each of ``jobs`` run in order, starting with ``loaded`` in
    memory: the warm estimate, plus the load cost when a job's checkpoint
    differs from the one before it. ``None`` for a job with no estimate.
    Pure."""
    out: list[float | None] = []
    current = loaded
    for job in jobs:
        warm = warm_estimate(runs, job)
        if warm is None:
            out.append(None)
        else:
            extra = 0.0
            if job.checkpoint and current and job.checkpoint != current:
                extra = load_cost(runs, job.checkpoint) or 0.0
            out.append(warm.seconds + extra)
        current = job.checkpoint or current
    return out


# -- Reading the history ----------------------------------------------------------


def _steps(inputs: dict[str, Any], gen: dict[str, Any] | None) -> int | None:
    steps = (inputs.get("sampling") or {}).get("steps")
    if steps is None and gen is not None:
        steps = sampling_defaults(gen["graph"], gen["slots"]).get("steps")
    try:
        return int(steps) if steps is not None else None
    except (TypeError, ValueError):
        return None


def _pixels(inputs: dict[str, Any]) -> int | None:
    w, h = inputs.get("width"), inputs.get("height")
    try:
        return int(w) * int(h) if w and h else None
    except (TypeError, ValueError):
        return None


class _Generators:
    """Generators by id, each read once per estimate."""

    def __init__(self) -> None:
        self._got: dict[str, dict[str, Any] | None] = {}

    async def get(self, generator_id: str) -> dict[str, Any] | None:
        from .generation_jobs import load_generator

        if generator_id not in self._got:
            self._got[generator_id] = await load_generator(generator_id)
        return self._got[generator_id]


# The status poll asks for an estimate every few seconds; the history only
# grows when a request finishes, so a short-lived copy serves those.
_HISTORY_TTL = 10.0
_cached: tuple[float, list[Run]] | None = None


def forget() -> None:
    """Drop the cached history (a run was recorded or removed)."""
    global _cached
    _cached = None


async def history(gens: _Generators | None = None) -> list[Run]:
    """The latest finished runs with a recorded time, newest first."""
    global _cached
    if _cached is not None and time.monotonic() - _cached[0] < _HISTORY_TTL:
        return _cached[1]
    runs = await _read_history(gens or _Generators())
    _cached = (time.monotonic(), runs)
    return runs


async def _read_history(gens: _Generators) -> list[Run]:
    r, b = t.generation_requests, t.generation_batches
    rt, rl = t.generation_run_times, t.generation_run_loads
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(
                    b.c.generator_id,
                    b.c.inputs,
                    r.c.images,
                    rt.c.seconds,
                    rl.c.cold,
                )
                .select_from(
                    rt.join(r, r.c._id == rt.c.request_id)
                    .join(b, b.c._id == r.c.batch_id)
                    .outerjoin(rl, rl.c.request_id == rt.c.request_id)
                )
                .where(r.c.state == "done")
                .order_by(r.c.finished_at.desc())
                .limit(HISTORY)
            )
        ).fetchall()
    out = []
    for row in rows:
        inputs = row.inputs or {}
        if inputs.get("test"):
            continue
        out.append(
            Run(
                generator=row.generator_id,
                checkpoint=inputs.get("checkpoint"),
                pixels=_pixels(inputs),
                steps=_steps(inputs, await gens.get(row.generator_id)),
                images=row.images or 1,
                seconds=row.seconds,
                cold=row.cold,
            )
        )
    return out


async def last_checkpoint() -> str | None:
    """The checkpoint of the request ComfyUI ran last for us: the one most
    likely still in memory."""
    r, b = t.generation_requests, t.generation_batches
    async with async_conn() as conn:
        inputs = (
            await conn.execute(
                sa.select(b.c.inputs)
                .select_from(r.join(b, b.c._id == r.c.batch_id))
                .where(r.c.finished_at.is_not(None), r.c.state == "done")
                .order_by(r.c.finished_at.desc())
                .limit(1)
            )
        ).scalar()
    return (inputs or {}).get("checkpoint")


async def _job(
    gens: _Generators, generator_id: str, inputs: dict[str, Any], images: int | None
) -> Job:
    return Job(
        generator=generator_id,
        checkpoint=inputs.get("checkpoint"),
        pixels=_pixels(inputs),
        steps=_steps(inputs, await gens.get(generator_id)),
        images=images or 1,
    )


async def queue_plan(
    started: dict[str, float],
    *,
    gens: _Generators | None = None,
    runs: list[Run] | None = None,
) -> dict[str, Any]:
    """Seconds left on the queue: per active batch, and the total. A running
    request counts what's left of its estimate (``started`` is when ComfyUI
    began each prompt). Each running or waiting request also gets its full
    estimate (``expected``), for the tile that fills as it runs."""
    gens = gens or _Generators()
    runs = runs if runs is not None else await history(gens)
    r, b = t.generation_requests, t.generation_batches
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(
                    r.c._id,
                    r.c.batch_id,
                    r.c.state,
                    r.c.images,
                    r.c.prompt_id,
                    b.c.generator_id,
                    b.c.inputs,
                )
                .select_from(r.join(b, b.c._id == r.c.batch_id))
                .where(r.c.state.in_(("pending", "queued", "running")))
                # Running first, then ComfyUI's queue, then ours, in order.
                .order_by(
                    sa.case(
                        (r.c.state == "running", 0), (r.c.state == "queued", 1), else_=2
                    ),
                    r.c.batch_id,
                    r.c.idx,
                )
            )
        ).fetchall()
    jobs = [
        await _job(gens, row.generator_id, row.inputs or {}, row.images) for row in rows
    ]
    seconds = plan(runs, jobs, await last_checkpoint())
    now = time.time()
    per_batch: dict[int, float | None] = {}
    expected: dict[int, float | None] = {}
    total: float | None = 0.0
    for row, s in zip(rows, seconds):
        expected[row._id] = s
        left = s
        if s is not None and row.state == "running" and row.prompt_id in started:
            left = max(0.0, s - (now - started[row.prompt_id]))
        if left is None:
            per_batch[row.batch_id] = None
            total = None
            continue
        if per_batch.get(row.batch_id, 0.0) is not None:
            per_batch[row.batch_id] = per_batch.get(row.batch_id, 0.0) + left
        if total is not None:
            total += left
    return {"batches": per_batch, "requests": expected, "total": total}


async def for_new(
    body: dict[str, Any], settings: dict[str, Any], started: dict[str, float]
) -> dict[str, Any]:
    """An estimate for a batch not queued yet (``body`` as the queue call
    takes it): its own seconds (``None`` when there's no history to go on),
    the part of that which is loading its checkpoint, and the seconds of
    queued work ahead of it (``None`` when some of that can't be told)."""
    from .generation_jobs import per_request_for

    gens = _Generators()
    generator_id = body.get("generator_id") or "builtin"
    gen = await gens.get(generator_id)
    empty = {"seconds": None, "load": None, "ahead": None, "basis": None, "samples": 0}
    if gen is None:
        return empty
    runs = await history(gens)
    queue = await queue_plan(started, gens=gens, runs=runs)
    count = max(1, min(500, int(body.get("count") or 1)))
    sizes = split_requests(count, per_request_for(gen, body, settings))
    inputs = {
        "checkpoint": body.get("checkpoint"),
        "width": body.get("width"),
        "height": body.get("height"),
        "sampling": body.get("sampling") or {},
    }
    jobs = [await _job(gens, generator_id, inputs, n) for n in sizes]
    # Whatever ran or is queued last is what's loaded when this one starts.
    ahead = await _last_queued_checkpoint()
    loaded = ahead if ahead is not None else await last_checkpoint()
    seconds = plan(runs, jobs, loaded)
    known = None if any(s is None for s in seconds) or not seconds else sum(seconds)
    load = None
    checkpoint = inputs.get("checkpoint")
    if known is not None and checkpoint and loaded and checkpoint != loaded:
        load = load_cost(runs, checkpoint)
    warm = warm_estimate(runs, jobs[0]) if jobs else None
    return {
        "seconds": known,
        "load": load,
        "ahead": queue["total"],
        "basis": warm.basis if warm else None,
        "samples": warm.samples if warm else 0,
    }


async def _last_queued_checkpoint() -> str | None:
    r, b = t.generation_requests, t.generation_batches
    async with async_conn() as conn:
        inputs = (
            await conn.execute(
                sa.select(b.c.inputs)
                .select_from(r.join(b, b.c._id == r.c.batch_id))
                .where(r.c.state.in_(("pending", "queued", "running")))
                .order_by(r.c.batch_id.desc(), r.c.idx.desc())
                .limit(1)
            )
        ).scalar()
    return (inputs or {}).get("checkpoint") if inputs is not None else None
