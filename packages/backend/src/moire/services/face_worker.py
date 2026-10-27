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

from . import activity, face_detect
from .ai_tagger_download import activity_item

logger = logging.getLogger("moire.faces")


class FaceWorker:
    def __init__(self) -> None:
        self._pending: set[str] = set()
        # Images queued since the worker last went idle: the "of N" in its
        # progress.
        self._batch = 0
        self._task: asyncio.Task | None = None
        self._avatars: asyncio.Task | None = None

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
            self._task = asyncio.create_task(self._drain(), name="face-detect")

    async def _drain(self) -> None:
        cache_dir = await face_detect.model_cache_dir()
        try:
            while self._pending:
                image_id = next(iter(self._pending))
                try:
                    await face_detect.detect_and_store(image_id, cache_dir)
                finally:
                    # Counted as pending until stored.
                    self._pending.discard(image_id)
        finally:
            activity.note_ended("faces")

    async def queue_avatars(self) -> None:
        """Every current avatar, so they are cropped before anyone opens a
        character. A no-op unless detection is on and downloaded."""
        if not await face_detect.ready():
            return
        from . import characters  # imports this module

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
