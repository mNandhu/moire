"""Index updates for the library watcher: the incremental counterpart to a
full scan, a burst of added, modified or deleted files at a time, reusing the
scan's per-file processing, worker pool, batched writer and upsert statements.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable

import sqlalchemy as sa

from ...database import schema as t
from ...database.db import sync_conn, sync_tx
from ..images import delete as image_delete
from ..metadata import reproject
from ..tags import image_tags, index as tag_index
from . import batch_pool, scanner
from .scan_writer import ScanWriter, retry
from .thumbnailer import is_image

logger = logging.getLogger(__name__)

# Rows per write transaction, as the full scan's writer.
_BATCH = 200


def _touch_library(conn, library_id: str, *, indexed_delta: int) -> None:
    """Nudge one watched library's `indexed_count`/`last_event_at` by a delta,
    inside the caller's transaction. A SQL-side increment (not a `SELECT
    COUNT(*)` + write) keeps a watcher batch O(batch) regardless of how
    many images the library already holds."""
    conn.execute(
        sa.update(t.libraries)
        .where(t.libraries.c._id == library_id)
        .values(
            indexed_count=sa.func.max(0, t.libraries.c.indexed_count + indexed_delta),
            last_event_at=datetime.utcnow().isoformat(),
        )
    )


def _write_rows(library_id: str, imgs: list[dict], raws: list[dict]) -> set[str]:
    """Upsert one batch of scanned rows in one short transaction. Returns the
    ids whose raw generation data it wrote (as stored)."""
    with sync_tx() as conn:
        # A stored row may spell its separator otherwise (an older scan on
        # another OS): update it under that id, not beside it.
        stored = {
            row["_id"]: image_tags.resolve_image_id_sync(conn, row["_id"])
            for row in imgs
        }
        rename = {i: s for i, s in stored.items() if s is not None and s != i}
        if rename:
            imgs = [{**r, "_id": rename.get(r["_id"], r["_id"])} for r in imgs]
            raws = [{**r, "_id": rename.get(r["_id"], r["_id"])} for r in raws]
        scanner.write_gen_raws(conn, raws)
        stmt = scanner.image_upsert_stmt()
        for row in imgs:
            conn.execute(stmt, row)
        new = sum(1 for s in stored.values() if s is None)
        _touch_library(conn, library_id, indexed_delta=new)
    return {r["_id"] for r in raws}


def ingest_files(
    library_id: str,
    root_path: Path,
    paths: Iterable[Path],
    *,
    is_cancelled: Callable[[], bool] = lambda: False,
) -> int:
    """Index files the watcher observed as added/modified (and found stable).

    The full scan's per-file work (`scanner.process_image`: decode, thumbnail,
    raw gen capture) runs on the scan's worker pool; rows commit in small
    batches like the scan's writer, never touching other rows of the library.
    Then, once for the whole burst: the tag views are invalidated and the
    post-scan step derives gen.* for the raws written. Returns how many rows
    were written."""
    files = [p for p in paths if is_image(p)]
    if not files:
        return 0
    written_raw_ids: set[str] = set()

    def _commit(imgs: list[dict], raws: list[dict]) -> None:
        written_raw_ids.update(
            retry(lambda: _write_rows(library_id, imgs, raws), base_delay_s=0.2)
        )

    writer = ScanWriter(_commit, batch_size=_BATCH)

    def _on_complete(res, exc) -> None:
        if exc is not None or res is None or not res.ok or res.doc is None:
            return  # process_image logged it; the reconcile scan retries
        writer.add(
            scanner.image_upsert_values(res.doc),
            scanner.gen_raw_values(res.gen_raw_doc)
            if res.gen_raw_doc is not None
            else None,
        )

    try:
        finished = batch_pool.run_pool(
            files,
            lambda p: scanner.process_image(library_id, root_path, p),
            _on_complete,
            max_workers=min(len(files), scanner.scan_workers()),
            is_cancelled=is_cancelled,
        )
        if finished:
            writer.flush()
    finally:
        # Whatever committed (a cancel or a failed batch may leave some) is
        # followed up once: a writer owning its transactions invalidates
        # after they commit.
        if writer.indexed:
            tag_index.invalidate()
        if written_raw_ids:
            # Only what this burst wrote: the library-wide sweeps of a scan's
            # follow-up (unstamped/underived rows, nested copies) are left to
            # real scans, so a folder saving one image every few seconds
            # costs a few rows each time, not a pass over the library.
            reproject.reproject_ids_async(sorted(written_raw_ids))
    return writer.indexed


def remove_images(library_id: str, image_ids: Iterable[str]) -> int:
    """Remove images the watcher observed as deleted (files no longer on
    disk). Mirrors the full scan's stale-reconciliation for these ids, in
    small transactions, with one tag-view invalidation for the burst.

    Resolves each id through the same slash/backslash-tolerant lookup as
    every other id-based operation (`image_tags.resolve_image_id_sync`), so a
    row whose stored id spells its separator differently than the watcher's
    freshly-computed id (e.g. written by an older scan on a different OS)
    still gets found instead of silently left behind. Returns how many rows
    went."""
    with sync_conn() as conn:
        resolved = sorted(
            {
                r
                for i in image_ids
                if (r := image_tags.resolve_image_id_sync(conn, i)) is not None
            }
        )
    if not resolved:
        return 0
    keys: list[str] = []
    try:
        for i in range(0, len(resolved), _BATCH):
            chunk = resolved[i : i + _BATCH]
            with sync_tx() as conn:
                # Counted inside the transaction: a row deleted meanwhile
                # (the UI's delete) is not counted off twice.
                present = conn.execute(
                    sa.select(sa.func.count())
                    .select_from(t.images)
                    .where(t.images.c._id.in_(chunk))
                ).scalar_one()
                keys += image_delete.delete_rows(conn, chunk)
                _touch_library(conn, library_id, indexed_delta=-present)
    finally:
        tag_index.invalidate()
        image_delete.drop_thumbs(keys)
    return len(resolved)
