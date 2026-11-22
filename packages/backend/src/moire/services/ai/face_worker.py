"""The background worker that finds faces in avatars (:mod:`face_detect`
holds the model and the per-image detection). Shaped like the other
managers: one :class:`FaceWorker` behind :func:`get_face_worker`.

Avatars are queued as they are listed (``characters``), and all at once
only on an explicit call (:meth:`FaceWorker.start_avatars`): at startup and
when the face model's download completes. Reading the face status never
queues anything."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .. import activity
from . import face_detect
from .tagger_download import activity_item

logger = logging.getLogger("moire.faces")

# How many images' faces one write transaction stores.
_STORE_BATCH = 8
# The detector is unloaded (its session and the heap it grew given back)
# after this long with nothing queued. Avatars are queued a few at a time
# as characters are listed: unloading after every short run would reload
# the model (and run a full gc) on every listing.
IDLE_UNLOAD_S = 120.0


class FaceWorker:
    def __init__(self) -> None:
        self._pending: set[str] = set()
        # Images queued since the worker last went idle: the "of N" in its
        # progress.
        self._batch = 0
        self._task: asyncio.Task | None = None
        self._avatars: asyncio.Task | None = None
        self._unload: asyncio.Task | None = None

    @property
    def pending(self) -> int:
        return len(self._pending)

    async def queue(self, image_ids: list[str]) -> None:
        """Find faces in these images in the background, skipping ones already
        looked at. Does nothing while detection is off or not downloaded."""
        ids = [i for i in dict.fromkeys(image_ids) if i and i not in self._pending]
        if not ids or not await face_detect.ready():
            return
        fresh = await face_detect.unchecked(ids)
        if not self._pending:
            self._batch = 0
        self._batch += len(set(fresh) - self._pending)
        self._pending.update(fresh)
        if self._pending and (self._task is None or self._task.done()):
            self._cancel_unload()
            self._task = asyncio.create_task(self._drain(), name="face-detect")

    def _cancel_unload(self) -> None:
        if self._unload is not None and not self._unload.done():
            self._unload.cancel()
        self._unload = None

    async def _unload_when_idle(self) -> None:
        await asyncio.sleep(IDLE_UNLOAD_S)
        if self._pending or (self._task is not None and not self._task.done()):
            return
        await asyncio.to_thread(face_detect.unload)

    async def _drain(self) -> None:
        # Images looked at but not stored yet: still pending (the progress
        # counts an image once stored), their rows in `rows`. Stored a batch
        # at a time, so the worker takes SQLite's writer slot once per
        # _STORE_BATCH images, not once each (an AI job's writes wait on it).
        held: set[str] = set()
        rows: list[dict] = []
        try:
            cache_dir = await face_detect.model_cache_dir()
            while True:
                image_id = next((i for i in self._pending if i not in held), None)
                if image_id is None or len(held) >= _STORE_BATCH:
                    await self._store(rows, held)
                    rows, held = [], set()
                    if image_id is None:
                        if not self._pending:
                            return
                        continue
                held.add(image_id)
                try:
                    row = await face_detect.look(image_id, cache_dir)
                except Exception:
                    # Not stored: queued again the next time it is listed.
                    logger.exception("Face detection failed for %s", image_id)
                    continue
                if row is not None:
                    rows.append(row)
        finally:
            self._pending -= held
            activity.note_ended("faces")
            if not self._pending:
                # Nothing awaits here: a queue() landing now sees this task
                # done and starts a new drain.
                self._cancel_unload()
                self._unload = asyncio.create_task(
                    self._unload_when_idle(), name="face-unload"
                )

    async def _store(self, rows: list[dict], held: set[str]) -> None:
        try:
            await face_detect.store(rows)
        except Exception:
            # Left unchecked: queued again the next time they are listed.
            logger.exception("Storing %d found faces failed", len(rows))
        finally:
            self._pending -= held

    async def queue_avatars(self) -> None:
        """Every current avatar, so they are cropped before anyone opens a
        character. A no-op unless detection is on and downloaded."""
        if not await face_detect.ready():
            return
        from ..characters import pages as characters  # imports this module

        await characters.listing()  # queues each avatar not looked at yet

    def start_avatars(self) -> None:
        """:meth:`queue_avatars` in the background (a full character query
        shouldn't hold up startup or a request)."""
        if self._avatars is not None and not self._avatars.done():
            return

        async def run() -> None:
            try:
                await self.queue_avatars()
            except Exception:
                logger.exception("Queueing avatars for face detection failed")

        self._avatars = asyncio.create_task(run(), name="face-avatars")

    def progress(self) -> tuple[int, int]:
        """``(done, total)`` of the images queued since the worker last went
        idle; ``(0, 0)`` while it is."""
        if not self._pending:
            return 0, 0
        return self._batch - len(self._pending), self._batch

    async def idle(self) -> None:
        """Wait for queued avatars and the worker to finish (tests)."""
        if self._avatars is not None:
            await self._avatars
        if self._task is not None:
            await self._task


_worker: FaceWorker | None = None


def get_face_worker() -> FaceWorker:
    global _worker
    if _worker is None:
        _worker = FaceWorker()
    return _worker


def reset_for_tests() -> None:
    global _worker
    _worker = None


def activity_items(cache_dir: str) -> list[dict[str, Any]]:
    """The face model's download and the detection pass, as activity-list
    items (``api/activity``); only those running."""
    items: list[dict[str, Any]] = []
    download = activity_item(
        "face-download", "face_download", face_detect.download_state(cache_dir)
    )
    if download:
        items.append(download)
    done, total = get_face_worker().progress()
    if total:
        items.append({"key": "faces", "kind": "faces", "done": done, "total": total})
    return items
