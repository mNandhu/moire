from __future__ import annotations

import asyncio
import logging
from collections import Counter, deque
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import sqlalchemy as sa
from PIL import Image

from ..database.db import async_conn
from ..database import schema as t
from . import image_tags
from .ai_settings import DEFAULT_AI_SETTINGS, get_ai_settings, update_ai_settings
from .ai_tagger import (
    PreparedImage,
    decode_image,
    get_tagger_manager,
    prepare_image,
    resolved_model_target,
)

logger = logging.getLogger("moire.ai_jobs")

__all__ = [
    "DEFAULT_AI_SETTINGS",
    "get_ai_settings",
    "update_ai_settings",
    "AIJobManager",
    "get_ai_job_manager",
]


def _discard(task: asyncio.Task) -> None:
    """Drop a prefetch nobody will await, without an unretrieved-exception log."""
    task.cancel()
    task.add_done_callback(lambda t: t.cancelled() or t.exception())


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

    def image_ids(self) -> list[str]:
        return list(getattr(self, "_ids", []))

    def throughput(self, now: float | None = None) -> dict[str, float]:
        """``rate`` (images a second) and, while running, ``eta_s``; empty
        until an image is through."""
        processed = self.done + self.failed
        if self.started_at is None or processed == 0:
            return {}
        end = self.finished_at or (now if now is not None else time.time())
        elapsed = end - self.started_at
        if elapsed <= 0:
            return {}
        rate = processed / elapsed
        out = {"rate": round(rate, 4), "elapsed_s": round(elapsed, 1)}
        # No time left for a job that is stopping.
        if self.finished_at is None and self.status == "running":
            out["eta_s"] = round(max(0, self.total - processed) / rate, 1)
        return out

    def public(self) -> dict[str, Any]:
        """Serializable view for the API. Excludes private attributes (e.g. the
        ``_ids`` work list stashed via ``setattr``), which would otherwise leak
        hundreds of image ids into every ``/status`` and ``/jobs`` poll."""
        out = {k: v for k, v in self.__dict__.items() if not k.startswith("_")}
        return {**out, **self.throughput()}


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
        # Jobs that have ended, however: the activity poll compares it to
        # notice a job that came and went between two polls.
        self.finished = 0

    def start(self) -> None:
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._worker_loop())
            # Start idle unload loop (uses manager-configured timeout)
            asyncio.create_task(get_tagger_manager().idle_unload_loop())

    def queue_depth(self) -> int:
        return self._queue.qsize()

    def active_jobs(self) -> list[AIJob]:
        """Every job not yet ended, oldest first."""
        jobs = [
            j
            for j in self._jobs.values()
            if j.status in ("queued", "running", "cancelling")
        ]
        return sorted(jobs, key=lambda j: j.created_at)

    def list_jobs(self, limit: int = 20) -> list[AIJob]:
        jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return jobs[: max(1, int(limit))]

    def get_job(self, job_id: str) -> AIJob | None:
        return self._jobs.get(job_id)

    async def enqueue(self, *, ids: list[str], force: bool = False) -> AIJob:
        job_id = uuid.uuid4().hex

        # De-dupe within the job while preserving order.
        unique_ids = list(dict.fromkeys([i for i in ids if i]))

        # De-dupe across jobs (optional).
        skipped = 0
        if force:
            accepted = unique_ids
        else:
            accepted = []
            for image_id in unique_ids:
                if image_id in self._in_flight:
                    skipped += 1
                    continue
                accepted.append(image_id)

        job = AIJob(
            id=job_id, created_at=time.time(), total=len(accepted), skipped=skipped
        )
        self._jobs[job_id] = job

        # Store ids on the job object (private field via attribute)
        setattr(job, "_ids", list(accepted))
        # Track in-flight ids so we don't queue duplicates across jobs.
        self._in_flight.update(accepted)

        if accepted:
            await self._queue.put(job)
        else:
            # Nothing to do; mark as done so UI doesn't show it as queued forever.
            job.status = "done"
            self.finished += 1
        return job

    async def enqueue_untagged(
        self, *, limit: int = 200, library_id: str | None = None
    ) -> AIJob | None:
        # Quarantined images are excluded, matching /ai/coverage and the
        # default gallery: a run must tag the set the UI counted for it.
        stmt = sa.select(t.images.c._id).where(
            t.images.c.has_ai_tags.is_(False),
            sa.func.coalesce(t.images.c.quarantined, False).is_(False),
        )
        if library_id:
            stmt = stmt.where(t.images.c.library_id == library_id)
        stmt = stmt.order_by(t.images.c._id.desc()).limit(int(limit))
        async with async_conn() as conn:
            ids = [row._id for row in (await conn.execute(stmt)).fetchall()]
        if not ids:
            return None
        return await self.enqueue(ids=ids)

    async def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False

        # If queued, remove from queue immediately.
        if job.status == "queued":
            removed = await self._queue.remove(job_id)
            job.status = "cancelled"
            self.finished += 1
            self._release(getattr(job, "_ids", []))
            return removed

        # If running, request cancellation (best-effort).
        if job.status in ("running", "cancelling"):
            job.cancel_requested = True
            job.status = "cancelling"
            return True

        # done/error/cancelled -> can't cancel
        return False

    async def _worker_loop(self) -> None:
        while True:
            job = await self._queue.get()
            # Job might have been cancelled before worker picked it up.
            if job.status == "cancelled":
                continue

            job.status = "running"
            ids: list[str] = getattr(job, "_ids", [])
            released = 0  # ids[:released] are processed and their claims dropped
            try:
                settings = await get_ai_settings()
                # Keep runtime idle timeout in sync
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
                    continue
                if not ready:
                    job.status = "cancelled"
                    continue
                job.phase = "tagging"
                job.started_at = time.time()

                # Read + decode of the next image overlaps inference on the
                # current one; `pending` is the load for ids[i].
                pending: asyncio.Task | None = None
                try:
                    for i, image_id in enumerate(ids):
                        if job.cancel_requested:
                            job.status = "cancelled"
                            break
                        job.current = image_id
                        load = pending or asyncio.create_task(
                            self._load_image(image_id)
                        )
                        pending = (
                            asyncio.create_task(self._load_image(ids[i + 1]))
                            if i + 1 < len(ids)
                            else None
                        )
                        try:
                            img = await load
                            await self._tag_one(
                                image_id=image_id,
                                image=img,
                                settings=settings,
                                model=model,
                            )
                            job.done += 1
                        except Exception as e:
                            logger.warning("AI tagging failed for %s: %s", image_id, e)
                            job.failed += 1
                            job.errors.append({"image_id": image_id, "error": str(e)})
                        self._release([image_id])
                        released = i + 1
                finally:
                    if pending is not None:
                        _discard(pending)

                if job.status != "cancelled":
                    job.status = "done" if job.failed == 0 else "error"
            except Exception as e:
                # Outside the per-image guard (settings read, setup): fail this
                # job, keep the worker alive for the next.
                logger.exception("AI job %s failed", job.id)
                job.status = "error"
                job.error = str(e)
                job.failed += len(ids) - released
            finally:
                job.current = None
                if job.started_at is not None:
                    job.finished_at = time.time()
                self.finished += 1
                self._release(ids[released:])

    def _release(self, ids: list[str]) -> None:
        """Drop one claim per id, so an id another job also holds stays claimed."""
        self._in_flight.subtract(ids)
        for image_id in ids:
            if self._in_flight[image_id] <= 0:
                del self._in_flight[image_id]

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
        doc = await image_tags.find_image(image_id, {"path": 1})
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

    async def _tag_one(
        self,
        *,
        image_id: str,
        image: Image.Image | PreparedImage,
        settings: dict[str, Any],
        model: tuple[str, str],
    ) -> None:
        model_repo, cache_dir = model

        result = await get_tagger_manager().predict_image(
            image=image,
            model_repo=model_repo,
            cache_dir=cache_dir,
            general_thresh=float(settings.get("general_thresh", 0.35)),
            character_thresh=float(settings.get("character_thresh", 0.85)),
            general_mcut=bool(settings.get("general_mcut", False)),
            character_mcut=bool(settings.get("character_mcut", False)),
            max_general=int(settings.get("max_general", 80)),
            max_character=int(settings.get("max_character", 40)),
        )

        general_tags = [t for (t, _p) in (result.get("general_tags") or [])]
        character_tags = [t for (t, _p) in (result.get("character_tags") or [])]
        ai_tags = list(dict.fromkeys([*general_tags, *character_tags]))

        # Pick rating with highest probability.
        rating_map = result.get("rating") or {}
        rating_label = "-"
        if isinstance(rating_map, dict) and rating_map:
            try:
                rating_label = max(
                    rating_map.items(), key=lambda kv: float(kv[1] or 0.0)
                )[0]
            except Exception:
                rating_label = "-"
        rating_label = image_tags.normalize_rating(str(rating_label)) or "-"

        now = time.time()
        ai_meta: dict[str, Any] = {
            "model_repo": model_repo,
            "caption": result.get("caption") or "",
            "rating": result.get("rating") or {},
            "general_tags": result.get("general_tags") or [],
            "character_tags": result.get("character_tags") or [],
            "general_thresh": float(settings.get("general_thresh", 0.35)),
            "character_thresh": float(settings.get("character_thresh", 0.85)),
            "updated_at": now,
        }

        # Replace prior AI tags with the new set, preserving manual tags.
        await image_tags.replace_ai(
            image_id, ai_tags=ai_tags, ai_meta=ai_meta, rating=rating_label
        )


_ai_job_manager: AIJobManager | None = None


def get_ai_job_manager() -> AIJobManager:
    global _ai_job_manager
    if _ai_job_manager is None:
        _ai_job_manager = AIJobManager()
    return _ai_job_manager
