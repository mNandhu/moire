"""Library lifecycle: add, edit (move, rename, watching) and remove a Library.

Each is an ordered run of side effects (the DB write, the nesting and tag
caches, the scan, the watcher, the libraries around it, the thumbnails), kept
here so the libraries router and the ComfyUI output folder setting share one
sequence. Routes validate, call and shape the response.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

import anyio  # type: ignore[import-not-found]
import sqlalchemy as sa

from ..core.config import settings
from ..database import schema as t
from ..database.db import async_conn, async_tx
from . import activity, image_delete, library_nesting, library_watch, tag_index
from .scanner import cancel_scan, restart_scan, scan_library_async
from .storage_fs import delete_by_prefix

logger = logging.getLogger("moire.libraries")

# Columns the list/summary views expose (kept minimal).
LIST_COLS = (
    t.libraries.c._id,
    t.libraries.c.path,
    t.libraries.c.name,
    t.libraries.c.indexed_count,
    t.libraries.c.last_scanned,
    t.libraries.c.scanning,
    t.libraries.c.scan_total,
    t.libraries.c.scan_done,
    t.libraries.c.scan_error,
    t.libraries.c.scan_failed_count,
    t.libraries.c.watch_enabled,
    t.libraries.c.last_event_at,
)


class BadPath(ValueError):
    """The folder doesn't exist or isn't a directory."""

    def __init__(self, path: Any) -> None:
        super().__init__(f"Path does not exist or is not a directory: {path}")


class NotFound(LookupError):
    """No library has that id."""


async def rescan_around(path: str, *, exclude: str) -> None:
    """Rescan every library holding ``path``, so it indexes the files of a
    library that was inside it and no longer is (removed, or moved away)."""
    async with async_conn() as conn:
        rows = (
            await conn.execute(sa.select(t.libraries.c._id, t.libraries.c.path))
        ).fetchall()
    key = library_nesting.path_key(path)
    for r in rows:
        if (
            r._id != exclude
            and r.path
            and library_nesting.is_inside(key, library_nesting.path_key(r.path))
        ):
            scan_library_async(r._id, r.path)


def library_id_for(path: str) -> str:
    """A library's id, from its (normalized) folder: the same folder added
    again gets the same id, so what points at its images by `_id` (a
    generation's outputs, a pinned cover) finds them again after the rescan.
    Libraries added before this keep their random ids."""
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:32]


async def listing() -> list[dict[str, Any]]:
    async with async_conn() as conn:
        rows = (await conn.execute(sa.select(*LIST_COLS))).fetchall()
    deleting = activity.running("delete")
    return [{**r._mapping, "deleting": r._id in deleting} for r in rows]


async def path_of(library_id: str) -> str | None:
    async with async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.libraries.c.path).where(t.libraries.c._id == library_id)
            )
        ).scalar()


async def create(path: str, name: str | None) -> dict[str, Any]:
    """Register ``path`` and start its first scan (and its watcher). An
    already-registered folder returns its full row; a new one returns
    ``_id``, ``path`` and ``name``. Raises BadPath."""
    # Dedupe before touching the filesystem: an already-registered library
    # whose drive is temporarily offline (unplugged external disk, unmounted
    # share) should still return the existing record on a repeat POST, not a
    # 400 that makes it look unregistered.
    # Compare folder keys, so a library stored before paths were normalized
    # (`D:/images/`) or spelled in another case on Windows (`d:/Images`) still
    # dedupes, the same way the add-library preview calls it registered.
    async with async_conn() as conn:
        rows = (await conn.execute(sa.select(t.libraries))).fetchall()
    key = library_nesting.path_key(path)
    existing = next(
        (r for r in rows if r.path and library_nesting.path_key(r.path) == key), None
    )
    if existing:
        return dict(existing._mapping)

    if not await anyio.to_thread.run_sync(lambda: Path(path).is_dir()):  # type: ignore[attr-defined]
        raise BadPath(path)
    watch_enabled = settings.watch_enabled_default
    async with async_tx() as conn:
        lib_id = library_id_for(path)
        await conn.execute(
            sa.insert(t.libraries).values(
                _id=lib_id,
                path=path,
                name=name or path,
                indexed_count=0,
                last_scanned=None,
                watch_enabled=watch_enabled,
            )
        )
    library_nesting.invalidate()
    # trigger initial scan in background; when it finishes, any library this
    # one sits inside hands over its copies of these files.
    scan_library_async(lib_id, path)
    if watch_enabled:
        await anyio.to_thread.run_sync(library_watch.start_watch, lib_id, path)  # type: ignore[attr-defined]
    return {"_id": lib_id, "path": path, "name": name or path}


async def ensure_watched(path: str, name: str) -> str:
    """The id of the library at ``path`` (registered if new), watched.
    Raises BadPath."""
    lib = await create(path, name)
    if not library_watch.is_watching(lib["_id"]):
        await update(lib["_id"], {"watch_enabled": True})
    return lib["_id"]


async def remove(library_id: str) -> None:
    # Shown as deleting until it's gone: a big library takes a while.
    with activity.track("delete", library_id=library_id):
        # Cancel an in-flight scan first to avoid the scan recreating rows/files after deletion.
        # Both join a thread, so off the loop (as main.py's shutdown does).
        # The watcher goes first, so it can't start a new scan meanwhile.
        await anyio.to_thread.run_sync(library_watch.stop_watch, library_id)  # type: ignore[attr-defined]
        await anyio.to_thread.run_sync(cancel_scan, library_id)  # type: ignore[attr-defined]

        async with async_tx() as conn:
            gone_path = (
                await conn.execute(
                    sa.select(t.libraries.c.path).where(t.libraries.c._id == library_id)
                )
            ).scalar()
            await conn.execute(
                sa.delete(t.libraries).where(t.libraries.c._id == library_id)
            )
            # image_tags / image_gen_terms cascade via FK when images are deleted.
            await image_delete.delete_library_rows_async(conn, library_id)
        # Every image of this library is gone, so every tag count moved.
        tag_index.invalidate()
        library_nesting.invalidate()
        # A library it sat inside takes its folder back.
        if gone_path:
            await rescan_around(gone_path, exclude=library_id)
        # remove thumbnail files for this library
        try:
            await anyio.to_thread.run_sync(lambda: delete_by_prefix(f"{library_id}/"))  # type: ignore[attr-defined]
        except Exception:
            # The library is already gone from the DB; leftover thumbs only waste space.
            logger.warning(
                "Failed to delete thumbnails for library %s", library_id, exc_info=True
            )


async def update(library_id: str, update_doc: dict[str, Any]) -> dict[str, Any] | None:
    """Apply a non-empty patch; a new ``path`` is a move (rescan here and in
    the libraries around the old folder). Raises BadPath, NotFound."""
    if "path" in update_doc and (
        update_doc["path"] is None
        or not await anyio.to_thread.run_sync(lambda: Path(update_doc["path"]).is_dir())
    ):  # type: ignore[attr-defined]
        raise BadPath(update_doc["path"])
    async with async_tx() as conn:
        old = (
            await conn.execute(
                sa.select(t.libraries).where(t.libraries.c._id == library_id)
            )
        ).first()
        if old is None:
            raise NotFound(library_id)
        await conn.execute(
            sa.update(t.libraries)
            .where(t.libraries.c._id == library_id)
            .values(**update_doc)
        )
        doc = (
            await conn.execute(
                sa.select(t.libraries).where(t.libraries.c._id == library_id)
            )
        ).first()
    result = dict(doc._mapping) if doc else None
    new_path = update_doc.get("path", old._mapping.get("path"))
    # Compare folder keys, so a name-only edit of a library stored as `/x/`
    # (or a case-only edit on Windows) doesn't count as a move.
    path_changed = "path" in update_doc and library_nesting.path_key(
        update_doc["path"]
    ) != library_nesting.path_key(old._mapping.get("path") or "")
    if path_changed:
        library_nesting.invalidate()
        restart_scan(library_id, new_path)
        # A library it was inside takes the old folder back.
        await rescan_around(old._mapping["path"], exclude=library_id)
    watch_enabled = update_doc.get("watch_enabled", old._mapping.get("watch_enabled"))
    if path_changed or "watch_enabled" in update_doc:
        if watch_enabled:
            await anyio.to_thread.run_sync(  # type: ignore[attr-defined]
                library_watch.start_watch, library_id, new_path
            )
        else:
            await anyio.to_thread.run_sync(library_watch.stop_watch, library_id)  # type: ignore[attr-defined]
    return result
