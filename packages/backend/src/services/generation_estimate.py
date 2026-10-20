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

A batch that leaves checkpoint, size or steps to the Generator counts the
graph's own value, so it matches runs that named the same one.

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
from .generator_graph import split_requests

EXACT_RUNS = 10
SCALED_RUNS = 20
# Runs read back for an estimate, newest first.
HISTORY = 400


@dataclass(frozen=True)
class Job:
    """One request's work."""

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
class Run:
    """One finished request: its work, how long it ran, and whether it loaded
    its checkpoint (``None``: not known)."""

    job: Job
    seconds: float
    cold: bool | None = None


@dataclass(frozen=True)
class Estimate:
    seconds: float
    # "exact" / "checkpoint" / "generator": which step of the ladder answered.
    basis: str
    samples: int


class _Memo:
    """Warm estimates and load costs over one history, each worked out once:
    a queue asks for the same ones many times."""

    def __init__(self, runs: list[Run]) -> None:
        self.runs = runs
        self._warm: dict[Job, Estimate | None] = {}
        self._extras: dict[str | None, list[float]] | None = None

    def warm(self, job: Job) -> Estimate | None:
        if job not in self._warm:
            self._warm[job] = _warm(self.runs, job)
        return self._warm[job]

    def load(self, checkpoint: str | None) -> float | None:
        if self._extras is None:
            # What each cold run took beyond its warm estimate (cold runs are
            # left out of that already).
            self._extras = {}
            for r in self.runs:
                if r.cold is not True:
                    continue
                warm = self.warm(r.job)
                if warm is not None:
                    self._extras.setdefault(r.job.checkpoint, []).append(
                        max(0.0, r.seconds - warm.seconds)
                    )
        pick = self._extras.get(checkpoint) or [
            x for xs in self._extras.values() for x in xs
        ]
        return statistics.median(pick) if pick else None


def _warm(runs: list[Run], job: Job) -> Estimate | None:
    warm = [r for r in runs if r.cold is not True and r.job.generator == job.generator]
    exact = [r.seconds for r in warm if r.job == job][:EXACT_RUNS]
    if exact:
        return Estimate(statistics.median(exact), "exact", len(exact))
    work = job.work
    if work is None:
        return None
    for basis, pool in (
        ("checkpoint", [r for r in warm if r.job.checkpoint == job.checkpoint]),
        ("generator", warm),
    ):
        rates = [r.seconds / w for r in pool if (w := r.job.work)][:SCALED_RUNS]
        if rates:
            return Estimate(statistics.median(rates) * work, basis, len(rates))
    return None


def warm_estimate(runs: list[Run], job: Job) -> Estimate | None:
    """The warm (model already loaded) seconds for ``job`` from ``runs``
    (newest first), by the ladder in the module docstring. Pure."""
    return _warm(runs, job)


def load_cost(runs: list[Run], checkpoint: str | None) -> float | None:
    """Seconds a checkpoint switch adds: the median of what cold runs took
    beyond their warm estimate, for ``checkpoint`` when it has cold runs,
    else for any. ``None`` with no cold run to go on. Pure."""
    return _Memo(runs).load(checkpoint)


def plan(runs: list[Run], jobs: list[Job], loaded: str | None) -> list[float | None]:
    """Seconds for each of ``jobs`` run in order, starting with ``loaded`` in
    memory: the warm estimate, plus the load cost when a job's checkpoint
    differs from the one before it. ``None`` for a job with no estimate.
    Pure."""
    memo = _Memo(runs)
    out: list[float | None] = []
    current = loaded
    for job in jobs:
        warm = memo.warm(job)
        if warm is None:
            out.append(None)
        else:
            extra = 0.0
            if job.checkpoint and current and job.checkpoint != current:
                extra = memo.load(job.checkpoint) or 0.0
            out.append(warm.seconds + extra)
        current = job.checkpoint or current
    return out


# -- Reading the history ----------------------------------------------------------


def _graph_value(gen: dict[str, Any] | None, key: str) -> Any:
    """What the Generator's graph has at slot ``key`` (None for a link)."""
    path = (gen or {}).get("slots", {}).get(key)
    if not path:
        return None
    value = (gen["graph"].get(str(path[0])) or {}).get("inputs", {}).get(path[1])
    return None if isinstance(value, list) else value


def _int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _job(
    gen: dict[str, Any] | None,
    generator_id: str,
    inputs: dict[str, Any],
    images: int | None,
) -> Job:
    """A request's work from its batch's inputs; what they leave unset is the
    graph's own value."""

    def pick(value: Any, key: str) -> Any:
        return value if value is not None else _graph_value(gen, key)

    w = _int(pick(inputs.get("width"), "width"))
    h = _int(pick(inputs.get("height"), "height"))
    return Job(
        generator=generator_id,
        checkpoint=pick(inputs.get("checkpoint") or None, "checkpoint"),
        pixels=w * h if w and h else None,
        steps=_int(pick((inputs.get("sampling") or {}).get("steps"), "steps")),
        images=images or 1,
    )


class _Generators:
    """Generators by id, each read once."""

    def __init__(self) -> None:
        self._got: dict[str, dict[str, Any] | None] = {}

    async def get(self, generator_id: str) -> dict[str, Any] | None:
        from .generation_jobs import load_generator

        if generator_id not in self._got:
            self._got[generator_id] = await load_generator(generator_id)
        return self._got[generator_id]


# The status poll asks for an estimate every few seconds; the history only
# grows when a request finishes, so a short-lived copy serves those (with the
# Generators read for it).
_HISTORY_TTL = 10.0
_cached: tuple[float, _Generators, list[Run]] | None = None
# Bumped by forget(), so a read that began before it isn't kept.
_epoch = 0


def forget() -> None:
    """Drop the cached history (a run was recorded or removed)."""
    global _cached, _epoch
    _cached = None
    _epoch += 1


async def _history() -> tuple[_Generators, list[Run]]:
    global _cached
    if _cached is not None and time.monotonic() - _cached[0] < _HISTORY_TTL:
        return _cached[1], _cached[2]
    epoch = _epoch
    gens = _Generators()
    runs = await _read_history(gens)
    if epoch == _epoch:
        _cached = (time.monotonic(), gens, runs)
    return gens, runs


async def history() -> list[Run]:
    """The latest finished runs with a recorded time, newest first."""
    return (await _history())[1]


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
        gen = await gens.get(row.generator_id)
        job = _job(gen, row.generator_id, inputs, row.images)
        out.append(Run(job, row.seconds, row.cold))
    return out


async def _last_checkpoint(gens: _Generators) -> str | None:
    """The checkpoint of the request ComfyUI ran last for us (a test run
    too): the one most likely still in memory."""
    r, b = t.generation_requests, t.generation_batches
    async with async_conn() as conn:
        row = (
            await conn.execute(
                sa.select(b.c.generator_id, b.c.inputs)
                .select_from(r.join(b, b.c._id == r.c.batch_id))
                .where(r.c.finished_at.is_not(None), r.c.state == "done")
                .order_by(r.c.finished_at.desc())
                .limit(1)
            )
        ).first()
    if row is None:
        return None
    gen = await gens.get(row.generator_id)
    return _job(gen, row.generator_id, row.inputs or {}, 1).checkpoint


async def queue_plan(started: dict[str, float]) -> dict[str, Any]:
    """Seconds left on the queue: per active batch (``batches``), and the
    total (``total``). A running request counts what's left of its estimate
    (``started`` is when ComfyUI began each prompt). Each running or waiting
    request also gets its full estimate (``requests``), for the tile that
    fills as it runs, and ``last`` is the checkpoint loaded once the queue
    is through."""
    gens, runs = await _history()
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
                        (r.c.state == "running", 0),
                        (r.c.state == "queued", 1),
                        else_=2,
                    ),
                    r.c.batch_id,
                    r.c.idx,
                )
            )
        ).fetchall()
    jobs = [
        _job(
            await gens.get(row.generator_id),
            row.generator_id,
            row.inputs or {},
            row.images,
        )
        for row in rows
    ]
    loaded = await _last_checkpoint(gens)
    seconds = plan(runs, jobs, loaded)
    for job in jobs:
        loaded = job.checkpoint or loaded
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
    return {"batches": per_batch, "requests": expected, "total": total, "last": loaded}


async def for_new(
    body: dict[str, Any], settings: dict[str, Any], started: dict[str, float]
) -> dict[str, Any]:
    """An estimate for a batch not queued yet (``body`` as the queue call
    takes it): its own seconds (``None`` when there's no history to go on),
    the part of that which is loading its checkpoint, and the seconds of
    queued work ahead of it (``None`` when some of that can't be told)."""
    from .builtin_generator import BUILTIN_ID
    from .generation_jobs import batch_shape

    gens, runs = await _history()
    generator_id = body.get("generator_id") or BUILTIN_ID
    gen = await gens.get(generator_id)
    if gen is None:
        return {
            "seconds": None,
            "load": None,
            "ahead": None,
            "basis": None,
            "samples": 0,
        }
    queue = await queue_plan(started)
    # The same inputs queue_batch would keep, so the key matches the history.
    shape = batch_shape(gen, body, settings)
    sizes = split_requests(shape["count"], shape["per_request"])
    jobs = [_job(gen, generator_id, shape, n) for n in sizes]
    # Whatever the queue ends on is what's loaded when this one starts.
    loaded = queue["last"]
    memo = _Memo(runs)
    seconds = plan(runs, jobs, loaded)
    known = None if any(s is None for s in seconds) else sum(seconds)
    checkpoint = jobs[0].checkpoint
    load = (
        memo.load(checkpoint)
        if known is not None and checkpoint and loaded and checkpoint != loaded
        else None
    )
    warm = memo.warm(jobs[0])
    return {
        "seconds": known,
        "load": load,
        "ahead": queue["total"],
        "basis": warm.basis if warm else None,
        "samples": warm.samples if warm else 0,
    }
