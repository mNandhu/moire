import logging
import hashlib
from pathlib import Path

from fastapi import APIRouter, HTTPException
import anyio  # type: ignore[import-not-found]

import sqlalchemy as sa

from ..core.config import settings
from ..database.db import async_conn, async_tx
from ..database import schema as t
from ..models.library import LibraryDiscoverIn, LibraryIn, LibraryUpdate
from ..services import activity, library_discover, library_nesting
from ..services.scanner import cancel_scan, scan_library_async

from ..services.storage_fs import delete_by_prefix
from ..services import tag_index
from ..services import library_watch

router = APIRouter()
logger = logging.getLogger("moire.libraries")

# Columns the list/summary views expose (kept minimal).
_LIB_LIST_COLS = (
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


async def _rescan_libraries_around(path: str, *, exclude: str) -> None:
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


@router.get("")
async def list_libraries():
    async with async_conn() as conn:
        rows = (await conn.execute(sa.select(*_LIB_LIST_COLS))).fetchall()
    deleting = activity.running("delete")
    return [{**r._mapping, "deleting": r._id in deleting} for r in rows]


@router.post("/discover")
async def discover_libraries(body: LibraryDiscoverIn):
    """Dry run for the Add Library dialog: the libraries that adding `paths`
    would create (optionally one per immediate subfolder), with image counts and
    conflicts against registered libraries. Writes nothing."""
    async with async_conn() as conn:
        existing = (await conn.execute(sa.select(t.libraries.c.path))).scalars().all()
    reports = await anyio.to_thread.run_sync(  # type: ignore[attr-defined]
        lambda: library_discover.discover(
            body.paths, split_subdirs=body.split_subdirs, existing_paths=existing
        )
    )
    return {"sources": library_discover.as_dicts(reports)}


@router.post("")
async def add_library(body: LibraryIn):
    # Dedupe before touching the filesystem: an already-registered library
    # whose drive is temporarily offline (unplugged external disk, unmounted
    # share) should still return the existing record on a repeat POST, not a
    # 400 that makes it look unregistered.
    # Compare normalized spellings, so a library stored before paths were
    # normalized (`D:/images/`) still dedupes against `D:/images`.
    async with async_conn() as conn:
        rows = (await conn.execute(sa.select(t.libraries))).fetchall()
    existing = next(
        (r for r in rows if library_discover.normalize_path(r.path) == body.path), None
    )
    if existing:
        return dict(existing._mapping)

    if not await anyio.to_thread.run_sync(lambda: Path(body.path).is_dir()):  # type: ignore[attr-defined]
        raise HTTPException(
            status_code=400,
            detail=f"Path does not exist or is not a directory: {body.path}",
        )
    watch_enabled = settings.watch_enabled_default
    async with async_tx() as conn:
        lib_id = library_id_for(body.path)
        await conn.execute(
            sa.insert(t.libraries).values(
                _id=lib_id,
                path=body.path,
                name=body.name or body.path,
                indexed_count=0,
                last_scanned=None,
                watch_enabled=watch_enabled,
            )
        )
    library_nesting.invalidate()
    # trigger initial scan in background; when it finishes, any library this
    # one sits inside hands over its copies of these files.
    scan_library_async(lib_id, body.path)
    if watch_enabled:
        await anyio.to_thread.run_sync(library_watch.start_watch, lib_id, body.path)  # type: ignore[attr-defined]
    return {"_id": lib_id, "path": body.path, "name": body.name or body.path}


@router.delete("/{library_id}")
async def remove_library(library_id: str):
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
            await conn.execute(
                sa.delete(t.images).where(t.images.c.library_id == library_id)
            )
            await conn.execute(
                sa.delete(t.image_gen_raw).where(
                    t.image_gen_raw.c.library_id == library_id
                )
            )
        # Every image of this library is gone, so every tag count moved.
        tag_index.invalidate()
        library_nesting.invalidate()
        # A library it sat inside takes its folder back.
        if gone_path:
            await _rescan_libraries_around(gone_path, exclude=library_id)
        # remove thumbnail files for this library
        try:
            await anyio.to_thread.run_sync(lambda: delete_by_prefix(f"{library_id}/"))  # type: ignore[attr-defined]
        except Exception:
            # The library is already gone from the DB; leftover thumbs only waste space.
            logger.warning(
                "Failed to delete thumbnails for library %s", library_id, exc_info=True
            )
    return {"removed": library_id}


@router.post("/{library_id}/rescan")
async def rescan_library(library_id: str):
    async with async_conn() as conn:
        path = (
            await conn.execute(
                sa.select(t.libraries.c.path).where(t.libraries.c._id == library_id)
            )
        ).scalar()
    if path is None:
        raise HTTPException(status_code=404, detail="Library not found")
    scan_library_async(library_id, path)
    return {"rescan": library_id, "started": True}


@router.post("/{library_id}/reproject")
async def reproject_library_endpoint(library_id: str):
    """Re-derive structured gen.* for a library from stored raw (no disk rescan)."""
    async with async_conn() as conn:
        found = (
            await conn.execute(
                sa.select(t.libraries.c._id).where(t.libraries.c._id == library_id)
            )
        ).scalar()
    if found is None:
        raise HTTPException(status_code=404, detail="Library not found")
    from ..services.reproject import reproject_library_async

    reproject_library_async(library_id)
    return {"reproject": library_id, "started": True}


@router.get("/{library_id}/progress")
async def library_progress(library_id: str):
    async with async_conn() as conn:
        lib = (
            await conn.execute(
                sa.select(t.libraries).where(t.libraries.c._id == library_id)
            )
        ).first()
    if lib is None:
        raise HTTPException(status_code=404, detail="Library not found")
    m = lib._mapping
    return {
        "scanning": bool(m.get("scanning", False)),
        "scan_total": m.get("scan_total", 0),
        "scan_done": m.get("scan_done", 0),
        "indexed_count": m.get("indexed_count", 0),
        "last_scanned": m.get("last_scanned"),
        "scan_error": m.get("scan_error"),
        "scan_failed_count": m.get("scan_failed_count", 0),
    }


@router.patch("/{library_id}")
async def update_library(library_id: str, body: LibraryUpdate):
    update_doc = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    if not update_doc:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "path" in update_doc and (
        update_doc["path"] is None
        or not await anyio.to_thread.run_sync(lambda: Path(update_doc["path"]).is_dir())
    ):  # type: ignore[attr-defined]
        raise HTTPException(
            status_code=400,
            detail=f"Path does not exist or is not a directory: {update_doc['path']}",
        )
    async with async_tx() as conn:
        old = (
            await conn.execute(
                sa.select(t.libraries).where(t.libraries.c._id == library_id)
            )
        ).first()
        if old is None:
            raise HTTPException(status_code=404, detail="Library not found")
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
    # The new path arrives normalized; normalize the stored one too, so a
    # name-only edit of a library stored as `/x/` doesn't count as a move.
    path_changed = "path" in update_doc and update_doc[
        "path"
    ] != library_discover.normalize_path(old._mapping.get("path") or "")
    if path_changed:
        library_nesting.invalidate()
        scan_library_async(library_id, new_path)
        # A library it was inside takes the old folder back.
        await _rescan_libraries_around(old._mapping["path"], exclude=library_id)
    watch_enabled = update_doc.get("watch_enabled", old._mapping.get("watch_enabled"))
    if path_changed or "watch_enabled" in update_doc:
        if watch_enabled:
            await anyio.to_thread.run_sync(  # type: ignore[attr-defined]
                library_watch.start_watch, library_id, new_path
            )
        else:
            await anyio.to_thread.run_sync(library_watch.stop_watch, library_id)  # type: ignore[attr-defined]
    return result
