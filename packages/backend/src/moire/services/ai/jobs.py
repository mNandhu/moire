from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import Counter, deque
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import sqlalchemy as sa
from PIL import Image

from ...core import memory
from ...database.db import async_conn, checkpoint_wal
from ...database import schema as t
from .. import activity, app_settings
from . import coverage as ai_coverage, estimate as ai_estimate
from ..tags import image_tags
from ..images import visibility as image_visibility
from .settings import get_ai_settings, update_ai_settings
from .tagger import (
    PreparedImage,
    TagParams,
    decode_image,
    get_tagger_manager,
    prepare_image,
    resolved_model_target,
)

logger = logging.getLogger("moire.ai_jobs")

_ACTIVE = ("queued", "running", "cancelling")
# How many ended jobs stay listed (list_jobs shows at most 20).
_KEEP_FINISHED = 50
# An ended job younger than this is kept past the cap, so a client still
# polling it sees its final status rather than a 404.
_KEEP_RECENT_S = 600.0
# Auto-tag waits this long after a nudge, so a burst of new files (the
# watcher ingests them one at a time) queues one job, not one each.
_AUTO_DELAY_S = 3.0
# The app_settings row of images auto-tag gave up on: id -> the file's mtime
# then. Kept across restarts; an image whose file changes gets another go.
_SKIP_ROW = "ai_auto_skip"
_CHUNK = 500
# The write-behind: how many tagged images may wait for their DB write
# before inference waits for it (memory stays bounded: tags, not pixels),
# and how many of those one write transaction takes at most.
_WRITE_DEPTH = 4
# A running job's rate and time left come from about its last minute: the
# whole-run average lags a rate that drifts (a GPU warming up, older and
# larger files last), so a long run's time left reads short.
_RECENT_S = 60.0
# Fewer seconds than this say more about warm-up than about the rate: the
# whole-run average until then.
_RECENT_MIN_S = 10.0
_WRITE_BATCH = 8

__all__ = [
    "AIJobManager",
    "get_ai_job_manager",
]


def _discard(task: asyncio.Task) -> None:
    """Drop a prefetch nobody will await, without an unretrieved-exception log."""
    task.cancel()
    task.add_done_callback(lambda t: t.cancelled() or t.exception())


def _note_end(job: "AIJob") -> None:
    """Count ``job`` as ended. One that tagged more than one image, or the
    images the sensitivity filter hides, also counts as ``ai_job_bulk``: the
    galleries refetch for those (a level may have shown images), not for an
    image's own re-tag.

    Every way a job ends comes here (run, cancelled while queued, nothing to
    do), so this is where the soft writes of a re-tag's clear end if the job
    did not end them itself: a failed model load or image, a cancel."""
    if job.cleared:
        job.cleared = False
        image_tags.end_bulk_writes(refresh=True)
    activity.note_ended("ai_job")
    if job.total > 1 or job.scope == "unknown":
        activity.note_ended("ai_job_bulk")


@dataclass
class AIJob:
    id: str
    created_at: float
    status: str = "queued"  # queued|running|cancelling|cancelled|done|error
    total: int = 0
    done: int = 0
    failed: int = 0
    skipped: int = 0
    current: str | None = None
    # "model" while the tagger model downloads or loads, then "tagging".
    phase: str | None = None
    error: str | None = None
    errors: list[dict[str, Any]] = field(default_factory=list)
    cancel_requested: bool = False
    # When the first image started (the model ready) and when the job ended:
    # the span its throughput is measured over.
    started_at: float | None = None
    finished_at: float | None = None
    # "unknown": queued for the images the sensitivity filter hides as having
    # no level yet (the gallery banner follows that job, not any other).
    # "auto": queued by auto-tag for images that arrived since.
    scope: str | None = None
    # Named images (an image's own re-tag, a selection): run between the
    # images of a long run instead of waiting for it to end.
    urgent: bool = False
    # Queued over the untagged backlog (auto-tag, or Tag on the AI page):
    # cancelling one pauses auto-tag, which would queue it straight back.
    backlog: bool = False
    # Seconds spent running urgent jobs between this job's images: not its
    # own tagging, so left out of the rate it records.
    nested_s: float = 0.0
    # Its images' AI tags were cleared (a re-tag), a soft write of the tag
    # views this job must end: set until it has (_note_end).
    cleared: bool = False
    # The work list. Kept off the API view (hundreds of ids per poll).
    ids: list[str] = field(default_factory=list, repr=False)
    # Images an urgent job tagged first: counted done, but they took no time
    # here, so left out of the rates.
    passed: int = 0
    # (time, images worked, nested_s) as it went, for the recent rate: one
    # a second at most, the oldest kept being the one the window starts
    # from. ``first`` is the first one: the rate recorded is measured from
    # it, past the first image's warm-up. Both kept off the API view.
    progress: deque = field(default_factory=deque, repr=False)
    first: tuple[float, int, float] | None = field(default=None, repr=False)

    def image_ids(self) -> list[str]:
        return list(self.ids)

    def _worked(self) -> int:
        """Images through that took this job's time (failures included)."""
        return self.done + self.failed - self.passed

    def mark_progress(self, now: float | None = None) -> None:
        """Note the images processed so far, for the rates."""
        now = time.time() if now is None else now
        if self.first is None:
            self.first = (now, self.done - self.passed, self.nested_s)
        samples = self.progress
        if samples and now - samples[-1][0] < 1.0:
            return
        samples.append((now, self._worked(), self.nested_s))
        # Drop what the window no longer needs: keep the newest sample at
        # least a window old, the one it starts from.
        while len(samples) > 1 and now - samples[1][0] >= _RECENT_S:
            samples.popleft()

    def _recent_rate(self, now: float) -> float | None:
        """Images a second over about the last ``_RECENT_S``, the time urgent
        jobs took left out; None while that covers too little time, or
        nothing went through in it (a stall: the whole-run rate then, not a
        time left of forever)."""
        start = next(
            (s for s in reversed(self.progress) if now - s[0] >= _RECENT_S),
            self.progress[0] if self.progress else None,
        )
        if start is None:
            return None
        span = now - start[0] - (self.nested_s - start[2])
        through = self._worked() - start[1]
        if span < _RECENT_MIN_S or through <= 0:
            return None
        return through / span

    def own_rate(self) -> tuple[float, int] | None:
        """An ended job's images tagged a second, measured from its first
        image on (past the warm-up), urgent jobs and the images they tagged
        left out, with the images it tagged; None if it can't say."""
        if self.first is None or self.finished_at is None:
            return None
        t0, tagged0, nested0 = self.first
        tagged = self.done - self.passed
        own = self.finished_at - t0 - (self.nested_s - nested0)
        if own <= 0 or tagged <= tagged0:
            return None
        return (tagged - tagged0) / own, tagged

    def throughput(self, now: float | None = None) -> dict[str, float]:
        """``rate`` (images a second) and, while running, ``eta_s``; empty
        until an image is through. A running job's rate is its recent one
        (``_RECENT_S``); an ended job's is over the whole run."""
        processed = self.done + self.failed
        if self.started_at is None or processed == 0:
            return {}
        end = self.finished_at or (now if now is not None else time.time())
        elapsed = end - self.started_at
        if elapsed <= 0:
            return {}
        rate = processed / elapsed
        out = {"elapsed_s": round(elapsed, 1)}
        # No time left for a job that is stopping, nor in its first seconds
        # (warm-up reads slow).
        if (
            self.finished_at is None
            and self.status == "running"
            and elapsed >= _RECENT_MIN_S
        ):
            rate = self._recent_rate(end) or rate
            out["eta_s"] = round(max(0, self.total - processed) / rate, 1)
        return {"rate": round(rate, 4), **out}

    def activity_item(self) -> dict[str, Any]:
        """This job as an activity-list item (``api/activity``)."""
        return {
            "key": f"ai:{self.id}",
            "kind": "ai_job",
            "job_id": self.id,
            "status": self.status,
            "phase": self.phase,
            "done": self.done + self.failed,
            "total": self.total,
            **self.throughput(),
            # A one-image job (an image's own "Run AI tagging") names it,
            # so that image's panel, opened again mid-job, follows it.
            **({"image_id": self.ids[0]} if self.total == 1 else {}),
            **({"scope": self.scope} if self.scope else {}),
        }

    def public(self) -> dict[str, Any]:
        """Serializable view for the API, without the ``ids`` work list."""
        out = {
            k: v
            for k, v in self.__dict__.items()
            if k not in ("ids", "progress", "first")
        }
        return {**out, **self.throughput()}


@dataclass
class _Tagged:
    """An inferred image waiting for its write: its place in the job's
    list and what to store (no pixels: the queue's memory is its tags)."""

    index: int
    write: image_tags.AIWrite
    found: bool


class _WriteBehind:
    """One job's AI tag writes, behind its inference: the tagging loop
    queues each inferred image and goes on to the next while a single
    writer task stores them, a few per transaction when they back up.
    ``put`` waits once ``_WRITE_DEPTH`` are queued (backpressure).
    ``write(batch, bulk=...)`` stores a batch, all or nothing;
    ``on_written(item)`` / ``on_failed(item, error)`` run once per image,
    in order, after its transaction ends."""

    _STOP = object()

    def __init__(self, write, on_written, on_failed, *, bulk: bool) -> None:
        self._write = write
        self._on_written = on_written
        self._on_failed = on_failed
        self._bulk = bulk
        self._q: asyncio.Queue = asyncio.Queue(maxsize=_WRITE_DEPTH)
        self._task = asyncio.create_task(self._run(), name="ai-write-behind")
        self._closed = False

    def _check(self) -> None:
        # A dead writer would leave put() and close() waiting forever.
        if self._task.done():
            self._task.result()  # its error, or CancelledError
            raise RuntimeError("the AI tag writer stopped")

    async def put(self, item: object) -> None:
        self._check()
        put = asyncio.ensure_future(self._q.put(item))
        while not put.done():
            await asyncio.wait({put, self._task}, return_when=asyncio.FIRST_COMPLETED)
            if not put.done() and self._task.done():
                put.cancel()
                self._check()

    async def flush(self) -> None:
        """Wait until everything queued so far is stored (or failed)."""
        self._check()
        join = asyncio.ensure_future(self._q.join())
        try:
            await asyncio.wait({join, self._task}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            if not join.done():
                join.cancel()
        self._check()

    async def close(self) -> None:
        """Store what is queued, then stop the writer. Idempotent."""
        if self._closed:
            return
        self._closed = True
        await self.put(self._STOP)
        await self._task

    async def abort(self) -> None:
        """Stop the writer now, dropping what is queued (the worker is being
        cancelled): a write in progress rolls back."""
        self._closed = True
        if not self._task.done():
            self._task.cancel()
        with contextlib.suppress(BaseException):
            await self._task

    async def _run(self) -> None:
        while True:
            first = await self._q.get()
            batch = [first]
            while len(batch) < _WRITE_BATCH and not self._q.empty():
                batch.append(self._q.get_nowait())
            stop = self._STOP in batch
            batch = [b for b in batch if b is not self._STOP]
            try:
                if batch:
                    await self._store(batch)
            finally:
                for _ in range(len(batch) + stop):
                    self._q.task_done()
            if stop:
                return

    async def _store(self, batch: list[_Tagged]) -> None:
        try:
            await self._write([b.write for b in batch], bulk=self._bulk)
        except Exception as e:
            if len(batch) == 1:
                self._settle(batch[0], e)
                return
            # One image's row may be the bad one: store the rest one by one.
            for item in batch:
                try:
                    await self._write([item.write], bulk=self._bulk)
                except Exception as e1:
                    self._settle(item, e1)
                else:
                    self._settle(item, None)
            return
        for item in batch:
            self._settle(item, None)

    def _settle(self, item: _Tagged, error: Exception | None) -> None:
        try:
            if error is None:
                self._on_written(item)
            else:
                self._on_failed(item, error)
        except Exception:
            # Bookkeeping must not kill the writer (the job would hang).
            logger.exception("AI job bookkeeping failed for %s", item.write.image_id)


class _JobQueue:
    """A tiny cancellable async queue.

    asyncio.Queue doesn't support removing queued items (needed for cancel).
    """

    def __init__(self) -> None:
        self._dq: deque[AIJob] = deque()
        self._cv = asyncio.Condition()

    def qsize(self) -> int:
        return len(self._dq)

    async def put(self, job: AIJob) -> None:
        async with self._cv:
            self._dq.append(job)
            self._cv.notify(1)

    async def get(self) -> AIJob:
        async with self._cv:
            while not self._dq:
                await self._cv.wait()
            return self._dq.popleft()

    def has_urgent(self) -> bool:
        return any(j.urgent for j in self._dq)

    def pop_urgent(self) -> AIJob | None:
        """Take the oldest queued urgent job, if any (no await: the worker
        calls it between images)."""
        for i, j in enumerate(self._dq):
            if j.urgent:
                del self._dq[i]
                return j
        return None

    async def remove(self, job_id: str) -> bool:
        async with self._cv:
            for i, j in enumerate(self._dq):
                if j.id == job_id:
                    del self._dq[i]
                    return True
            return False


class AIJobManager:
    def __init__(self) -> None:
        self._queue = _JobQueue()
        self._jobs: dict[str, AIJob] = {}
        self._worker_task: asyncio.Task | None = None
        # Prevent queueing the same image many times across jobs.
        # Claims per image id, held from enqueue until that image is processed.
        self._in_flight: Counter[str] = Counter()
        # Images that failed, or that the tagger found nothing in: auto-tag
        # leaves them out until their file changes, so it doesn't queue them
        # again after every scan or restart (a run started by hand still
        # includes them). Id -> mtime, loaded from _SKIP_ROW on first use.
        self._auto_skip: dict[str, float | None] | None = None
        # Given up on in a job still running: stored, with mtimes, at its end.
        self._skip_new: set[str] = set()
        # Ids an urgent job took over from a job already holding them: that
        # job skips them when it gets there instead of tagging them twice.
        self._taken: set[str] = set()
        # A nudge came while auto-tag was already querying: run it once more.
        self._auto_again = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._auto_task: asyncio.Task | None = None

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._worker_loop())

    async def stop(self) -> None:
        """Cancel the worker (a running job is abandoned with the process)."""
        auto, self._auto_task = self._auto_task, None
        if auto is not None and not auto.done():
            auto.cancel()
        self._loop = None
        task, self._worker_task = self._worker_task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def _prune(self) -> None:
        """Forget all but the newest ``_KEEP_FINISHED`` ended jobs; a job still
        queued or running, or ended within ``_KEEP_RECENT_S``, is always kept."""
        ended = [j for j in self._jobs.values() if j.status not in _ACTIVE]
        ended.sort(key=lambda j: j.created_at, reverse=True)
        cutoff = time.time() - _KEEP_RECENT_S
        for j in ended[_KEEP_FINISHED:]:
            if (j.finished_at or 0.0) < cutoff:
                del self._jobs[j.id]

    def queue_depth(self) -> int:
        return self._queue.qsize()

    def active_jobs(self) -> list[AIJob]:
        """Every job not yet ended, oldest first."""
        jobs = [j for j in self._jobs.values() if j.status in _ACTIVE]
        return sorted(jobs, key=lambda j: j.created_at)

    def list_jobs(self, limit: int = 20) -> list[AIJob]:
        jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return jobs[: max(1, int(limit))]

    def get_job(self, job_id: str) -> AIJob | None:
        return self._jobs.get(job_id)

    async def enqueue(
        self,
        *,
        ids: list[str],
        force: bool = False,
        scope: str | None = None,
        urgent: bool = False,
        backlog: bool = False,
        cleared: bool = False,
    ) -> AIJob:
        """``cleared``: the caller cleared these images' AI tags first
        (``image_tags.clear_ai``, a soft write); the job ends it."""
        job_id = uuid.uuid4().hex

        # De-dupe within the job while preserving order.
        unique_ids = list(dict.fromkeys([i for i in ids if i]))

        # De-dupe across jobs (optional).
        skipped = 0
        if force:
            accepted = unique_ids
        else:
            accepted = []
            held = set()
            for image_id in unique_ids:
                if image_id in self._in_flight:
                    if urgent:
                        # Named images don't wait for the long run holding
                        # them: this job tags them now, that one skips them.
                        accepted.append(image_id)
                        continue
                    held.add(image_id)
                    continue
                accepted.append(image_id)
            skipped = len(held)
            if scope and held:
                # Another job already tags some of these: it does this job's
                # work, so it answers to the scope too (the hidden-images
                # banner follows it).
                for other in self.active_jobs():
                    if other.scope in (None, "auto") and not held.isdisjoint(other.ids):
                        other.scope = scope

        self._prune()
        job = AIJob(
            id=job_id,
            created_at=time.time(),
            total=len(accepted),
            skipped=skipped,
            scope=scope,
            urgent=urgent,
            backlog=backlog,
            ids=list(accepted),
            cleared=cleared,
        )
        self._jobs[job_id] = job
        # Track in-flight ids so we don't queue duplicates across jobs.
        self._in_flight.update(accepted)

        if accepted:
            await self._queue.put(job)
        else:
            # Nothing to do; mark as done so UI doesn't show it as queued forever.
            job.status = "done"
            _note_end(job)
        return job

    @staticmethod
    def _untagged_ids(library_id: str | None = None, *, unknown: bool = False):
        """The images a run tags, newest file first: the set /ai/coverage
        counts (ai_coverage.untagged_clause). ``unknown``: only those with no
        sensitivity level yet, which the sensitivity filter hides."""
        stmt = sa.select(t.images.c._id, t.images.c.mtime).where(
            ai_coverage.untagged_clause(library_id)
        )
        if unknown:
            stmt = stmt.where(image_visibility.image_level().is_(None))
        return stmt.order_by(t.images.c.mtime.desc(), t.images.c._id.desc())

    async def enqueue_untagged(
        self,
        *,
        limit: int | None = None,
        library_id: str | None = None,
        unknown: bool = False,
    ) -> AIJob | None:
        """Queue the images without AI tags, newest file first; ``limit``
        None queues every one of them."""
        stmt = self._untagged_ids(library_id, unknown=unknown)
        if limit is not None:
            stmt = stmt.limit(max(1, int(limit)))
        async with async_conn() as conn:
            ids = [row._id for row in (await conn.execute(stmt)).fetchall()]
        if not ids:
            return None
        return await self.enqueue(
            ids=ids, scope="unknown" if unknown else None, backlog=True
        )

    async def auto_tag(self) -> AIJob | None:
        """With the ``auto_tag`` setting on, queue every image without AI
        tags that no job holds yet and auto-tag hasn't given up on. Waits
        for running scans: the one that ends nudges again."""
        from ..library import scanner  # scanner nudges this module: import late

        if scanner.any_scanning():
            return None
        if not (await get_ai_settings()).get("auto_tag"):
            return None
        skip = await self._skip_list()
        async with async_conn() as conn:
            rows = (await conn.execute(self._untagged_ids())).fetchall()
        # Still untagged and the same file: still given up on. The rest
        # (tagged by hand since, changed, deleted) drop off the list.
        kept = {
            r._id: r.mtime for r in rows if r._id in skip and skip[r._id] == r.mtime
        }
        if len(kept) != len(skip):
            await self._store_skip(kept)
        ids = [
            r._id for r in rows if r._id not in self._in_flight and r._id not in kept
        ]
        if not ids:
            return None
        return await self.enqueue(ids=ids, scope="auto", backlog=True)

    async def _skip_list(self) -> dict[str, float | None]:
        if self._auto_skip is None:
            try:
                self._auto_skip = dict(await app_settings.read(_SKIP_ROW) or {})
            except Exception:
                logger.debug("Could not read the auto-tag skip list", exc_info=True)
                return {}
        return self._auto_skip

    async def _store_skip(self, skip: dict[str, float | None]) -> None:
        self._auto_skip = skip
        try:
            await app_settings.write(_SKIP_ROW, skip)
        except Exception:
            logger.debug("Could not store the auto-tag skip list", exc_info=True)

    async def _flush_skip(self) -> None:
        """Add the images given up on since the last flush, with their
        file's mtime now."""
        new, self._skip_new = list(self._skip_new), set()
        if not new:
            return
        skip = dict(await self._skip_list())
        async with async_conn() as conn:
            for i in range(0, len(new), _CHUNK):
                stmt = sa.select(t.images.c._id, t.images.c.mtime).where(
                    t.images.c._id.in_(new[i : i + _CHUNK])
                )
                for r in (await conn.execute(stmt)).fetchall():
                    skip[r._id] = r.mtime
        await self._store_skip(skip)

    def nudge(self) -> None:
        """Run :meth:`auto_tag` shortly: new images may have arrived. Safe
        from any thread (the scanner and the watcher call it from theirs);
        nudges within ``_AUTO_DELAY_S`` of each other share one run."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._schedule_auto)
        except RuntimeError:  # the loop closed in between
            pass

    def _schedule_auto(self) -> None:
        if self._auto_task is not None and not self._auto_task.done():
            # It may be past its query already: images that arrived since
            # need one more pass.
            self._auto_again = True
            return

        async def _later() -> None:
            while True:
                await asyncio.sleep(_AUTO_DELAY_S)
                self._auto_again = False
                try:
                    await self.auto_tag()
                except Exception:
                    logger.exception("Auto-tag could not queue the new images")
                if not self._auto_again:
                    return

        self._auto_task = asyncio.create_task(_later())

    async def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.backlog and job.status in _ACTIVE:
            # Auto-tag would queue the backlog straight back at the next
            # scan or new file: cancelling it turns auto-tag off.
            await self._turn_auto_tag_off()

        # If queued, remove from queue immediately.
        if job.status == "queued":
            removed = await self._queue.remove(job_id)
            job.status = "cancelled"
            _note_end(job)
            self._release(job.ids)
            return removed

        # If running, request cancellation (best-effort).
        if job.status in ("running", "cancelling"):
            job.cancel_requested = True
            job.status = "cancelling"
            return True

        # done/error/cancelled -> can't cancel
        return False

    @staticmethod
    async def _turn_auto_tag_off() -> None:
        try:
            if (await get_ai_settings()).get("auto_tag"):
                await update_ai_settings({"auto_tag": False})
        except Exception:
            logger.warning("Could not turn auto-tag off", exc_info=True)

    async def _worker_loop(self) -> None:
        while True:
            job = await self._queue.get()
            # Job might have been cancelled before worker picked it up.
            if job.status == "cancelled":
                continue
            await self._run_job(job)

    async def _run_urgent(
        self,
        outer: AIJob,
        run: tuple[dict[str, Any], tuple[str, str]],
        writer: _WriteBehind,
    ) -> None:
        """Run the urgent jobs queued meanwhile, between two images of a long
        run, so an image's own re-tag doesn't wait hours behind it. They use
        the long run's settings and model: a model change mid-run would
        otherwise swap the model back and forth."""
        if not self._queue.has_urgent():
            return
        # The run's queued writes land first: an older result must not land
        # over an urgent re-tag of the same image.
        await writer.flush()
        while (job := self._queue.pop_urgent()) is not None:
            if job.status != "cancelled":
                began = time.time()
                await self._run_job(job, nested=run)
                outer.nested_s += time.time() - began

    async def _run_job(
        self,
        job: AIJob,
        *,
        nested: tuple[dict[str, Any], tuple[str, str]] | None = None,
    ) -> None:
        job.status = "running"
        ids = job.ids
        # Indexes into ids that are processed and their claims dropped. Not
        # a prefix: a failed image is settled at once, while the images
        # before it may still wait for their write.
        finished: set[int] = set()
        checkpoint = False  # truncate the WAL once the run is wrapped up
        cancelled = False
        writer: _WriteBehind | None = None

        def finish(i: int) -> None:
            image_id = ids[i]
            if job.urgent and self._in_flight[image_id] > 1:
                # Another job still holds it: that one skips it.
                self._taken.add(image_id)
            self._release([image_id])
            finished.add(i)

        def failed(i: int, e: Exception) -> None:
            logger.warning("AI tagging failed for %s: %s", ids[i], e)
            job.failed += 1
            job.errors.append({"image_id": ids[i], "error": str(e)})
            self._skip_new.add(ids[i])
            finish(i)
            job.mark_progress()

        def written(item: _Tagged) -> None:
            if not item.found:
                self._skip_new.add(ids[item.index])
            if job.total == 1:
                # Its write refreshed the views (bulk=False).
                job.cleared = False
            job.done += 1
            finish(item.index)
            job.mark_progress()

        try:
            if nested is not None:
                settings, model = nested
            else:
                settings = await get_ai_settings()
                # Startup sets the idle timeout best-effort; a failed read
                # there must not pin the default for the process lifetime.
                get_tagger_manager().set_idle_unload_s(
                    int(settings.get("idle_unload_s", 0) or 0)
                )
                model = resolved_model_target(settings)
            try:
                ready = await self._prepare_model(job, *model)
            except Exception as e:
                logger.warning("AI tagging could not load the model: %s", e)
                job.status = "error"
                job.error = str(e)
                job.failed = len(ids)
                return
            if not ready:
                job.status = "cancelled"
                return
            job.phase = "tagging"
            job.started_at = time.time()

            # Each image's DB write runs behind the next one's inference.
            # Only a run of many lags the views; one image (its own re-tag)
            # refreshes them at once.
            writer = _WriteBehind(
                self._write_tags,
                written,
                lambda item, e: failed(item.index, e),
                bulk=job.total > 1,
            )
            # Read + decode of the next image overlaps inference on the
            # current one; `pending` is the load for ids[i].
            pending: asyncio.Task | None = None
            try:
                for i, image_id in enumerate(ids):
                    if nested is None and i > 0:
                        await self._run_urgent(job, (settings, model), writer)
                    if job.cancel_requested:
                        # The images already inferred are still stored (the
                        # close below): the job ends once they are.
                        cancelled = True
                        break
                    if not job.urgent and image_id in self._taken:
                        # An urgent job tagged it meanwhile.
                        self._taken.discard(image_id)
                        if pending is not None:
                            _discard(pending)
                            pending = None
                        job.done += 1
                        job.passed += 1
                        finish(i)
                        job.mark_progress()
                        continue
                    job.current = image_id
                    load = pending or asyncio.create_task(self._load_image(image_id))
                    pending = (
                        asyncio.create_task(self._load_image(ids[i + 1]))
                        if i + 1 < len(ids)
                        else None
                    )
                    try:
                        img = await load
                        write = await self._infer_one(
                            image_id=image_id,
                            image=img,
                            settings=settings,
                            model=model,
                        )
                    except Exception as e:
                        failed(i, e)
                        continue
                    # Waits only while _WRITE_DEPTH writes are queued.
                    await writer.put(_Tagged(i, write, found=bool(write.ai_tags)))
            finally:
                if pending is not None:
                    _discard(pending)
            # Every write lands (or fails) before the job counts as ended.
            await writer.close()

            if cancelled:
                job.status = "cancelled"
            else:
                job.status = "done" if job.failed == 0 else "error"
        except asyncio.CancelledError:
            # The worker is stopping: drop the queued writes with it, so none
            # runs on after the job.
            if writer is not None:
                await writer.abort()
            raise
        except Exception as e:
            # Outside the per-image guard (settings read, setup): fail this
            # job, keep the worker alive for the next.
            logger.exception("AI job %s failed", job.id)
            if writer is not None:
                try:
                    await writer.close()
                except Exception:
                    await writer.abort()
            job.status = "error"
            job.error = str(e)
            job.failed += len(ids) - len(finished)
        finally:
            job.current = None
            try:
                await self._flush_skip()
            except Exception:
                logger.debug("Could not store the auto-tag skip list", exc_info=True)
            if job.started_at is not None:
                job.finished_at = time.time()
                # A nested job's writes are part of the run around it, which
                # ends them and measures the rate.
                if job.total > 1 and nested is None:
                    # The tag views lagged this job's writes (bulk=True):
                    # served once more while each rebuilds, so the first
                    # reader after a job doesn't wait for the rebuild.
                    image_tags.end_bulk_writes(refresh=True)
                    job.cleared = False
                    checkpoint = True
                    # Failures and urgent jobs left out: a failure is quick,
                    # and neither is tagging.
                    if (measured := job.own_rate()) is not None:
                        await ai_estimate.record(
                            ai_estimate.current_device(), model[0], *measured
                        )
            _note_end(job)
            self._release([x for i, x in enumerate(ids) if i not in finished])
            if checkpoint:
                # Last, off the event loop: a cancel at this await must not
                # skip the bookkeeping above.
                await asyncio.to_thread(checkpoint_wal)
            if nested is None and job.total > 1 and not self._queue.qsize():
                # The run's decoded images and tensors are freed, but glibc
                # keeps the pages (a long job ratchets RSS toward gigabytes).
                await asyncio.to_thread(memory.trim)

    def _release(self, ids: list[str]) -> None:
        """Drop one claim per id, so an id another job also holds stays claimed."""
        self._in_flight.subtract(ids)
        for image_id in ids:
            if self._in_flight[image_id] <= 0:
                del self._in_flight[image_id]
                self._taken.discard(image_id)

    async def _prepare_model(self, job: AIJob, repo: str, cache_dir: str) -> bool:
        """Load the tagger model before the first image, through the shared
        background load, so its download and load show as progress. Returns
        False if the job was cancelled meanwhile; the load itself goes on."""
        mgr = get_tagger_manager()
        st = mgr.status()
        if st["loaded"] and st["repo"] == repo:
            return True
        job.phase = "model"
        mgr.start_load(model_repo=repo, cache_dir=cache_dir)
        load = asyncio.ensure_future(
            mgr.ensure_loaded(model_repo=repo, cache_dir=cache_dir)
        )
        while not load.done():
            if job.cancel_requested:
                # Not cancelled: it may be awaiting the shared load, which
                # cancelling would cancel too.
                load.add_done_callback(lambda f: f.cancelled() or f.exception())
                return False
            await asyncio.wait({load}, timeout=0.5)
        try:
            load.result()
        except asyncio.CancelledError:
            # The shared load was cancelled (Cancel on the AI page, or a new
            # cache dir), not this worker: a failed job, not a dead worker.
            raise RuntimeError("The model load was cancelled") from None
        return True

    async def _load_image(self, image_id: str) -> PreparedImage:
        """Read, decode and (with the model loaded) resize an image's original
        to the model's input, off the event loop. Running as the prefetch, it
        overlaps all of that with inference on the previous image."""
        # Tagging is how a hidden image gets a level: never filtered.
        doc = await image_tags.find_image(image_id, ("path",), within_filter=False)
        if not doc:
            raise RuntimeError("image not found")
        path = doc.get("path")
        if not path:
            raise RuntimeError("image has no file path")

        size = get_tagger_manager().input_size()

        def _read() -> PreparedImage:
            with open(str(path), "rb") as f:
                img = decode_image(f.read())
            return PreparedImage(img, prepare_image(img, size) if size else None)

        return await asyncio.to_thread(_read)

    async def _infer_one(
        self,
        *,
        image_id: str,
        image: Image.Image | PreparedImage,
        settings: dict[str, Any],
        model: tuple[str, str],
    ) -> image_tags.AIWrite:
        """Run the tagger on one image: what to store for it (the job's
        write-behind stores it, :meth:`_write_tags`)."""
        model_repo, cache_dir = model
        params = TagParams.from_settings(settings)

        result = await get_tagger_manager().predict_image(
            image=image,
            model_repo=model_repo,
            cache_dir=cache_dir,
            params=params,
        )

        general_tags = [t for (t, _p) in (result.get("general_tags") or [])]
        character_tags = [t for (t, _p) in (result.get("character_tags") or [])]
        ai_tags = list(dict.fromkeys([*general_tags, *character_tags]))

        ai_meta: dict[str, Any] = {
            "model_repo": model_repo,
            "caption": result.get("caption") or "",
            "rating": result.get("rating") or {},
            "general_tags": result.get("general_tags") or [],
            "character_tags": result.get("character_tags") or [],
            "general_thresh": params.general_thresh,
            "character_thresh": params.character_thresh,
            "updated_at": time.time(),
        }
        return image_tags.AIWrite(
            image_id=image_id,
            ai_tags=ai_tags,
            ai_meta=ai_meta,
            rating=image_tags.ai_rating_label(result.get("rating")),
        )

    @staticmethod
    async def _write_tags(writes: list[image_tags.AIWrite], *, bulk: bool) -> None:
        """Store inferred images, replacing their prior AI tags (manual and
        prompt tags stay), in one transaction."""
        await image_tags.replace_ai_many(writes, bulk=bulk)


_ai_job_manager: AIJobManager | None = None


def heavy_active() -> bool:
    """Whether tagging or face detection is running now, for work that should
    leave it cores (the scan's pool). A hint, read from any thread."""
    from .face_worker import get_face_worker

    if get_face_worker().pending:
        return True
    mgr = _ai_job_manager
    if mgr is None:
        return False
    try:
        running = [j for j in list(mgr._jobs.values()) if j.status == "running"]
    except RuntimeError:  # the dict changed under the copy
        return True
    return any(j.total > 1 for j in running)


def get_ai_job_manager() -> AIJobManager:
    global _ai_job_manager
    if _ai_job_manager is None:
        _ai_job_manager = AIJobManager()
    return _ai_job_manager
