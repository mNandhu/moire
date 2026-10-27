"""Single-file index updates for the library watcher: the incremental
counterpart to a full scan, one added, modified or deleted file at a time,
reusing the scan's per-file processing and upsert statements.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import sync_conn, sync_tx
from . import image_delete, image_tags, scanner, tag_index
from .thumbnailer import is_image

logger = logging.getLogger(__name__)


def _touch_library(conn, library_id: str, *, indexed_delta: int) -> None:
    """Nudge one watched library's `indexed_count`/`last_event_at` by a delta,
    inside the caller's transaction. A SQL-side increment (not a `SELECT
    COUNT(*)` + write) keeps a single watcher event O(1) regardless of how
    many images the library already holds."""
    conn.execute(
        sa.update(t.libraries)
        .where(t.libraries.c._id == library_id)
        .values(
            indexed_count=sa.func.max(0, t.libraries.c.indexed_count + indexed_delta),
            last_event_at=datetime.utcnow().isoformat(),
        )
    )


def ingest_single_file(library_id: str, root_path: Path, path: Path) -> bool:
    """Index one file the watcher observed as added/modified.

    Mirrors one iteration of the full scan (`scanner.process_image` + the same
    upsert statements) without touching any other row, the incremental
    counterpart to `scanner.scan_library_async`'s batch walk. Returns ``True`` on
    success (including "not an image, skipped").
    """
    if not is_image(path):
        return True
    res = scanner.process_image(library_id, root_path, path)
    if not res.ok or res.doc is None:
        return False
    with sync_tx() as conn:
        existed = (
            conn.execute(
                sa.select(t.images.c._id).where(t.images.c._id == res.image_id)
            ).first()
            is not None
        )
        if res.gen_raw_doc is not None:
            conn.execute(
                scanner.gen_raw_upsert_stmt(), scanner.gen_raw_values(res.gen_raw_doc)
            )
        conn.execute(scanner.image_upsert_stmt(), scanner.image_upsert_values(res.doc))
        _touch_library(conn, library_id, indexed_delta=0 if existed else 1)
    # A brand-new row carries no gen data to reproject over, but a modified
    # file may have replaced its embedded metadata, so re-deriving is always safe.
    if res.gen_raw_doc is not None:
        try:
            from .reproject import reproject_image

            reproject_image(res.image_id)
        except Exception:
            # Re-runnable via the manual endpoint, as after a full scan.
            logger.warning("Reprojection failed for %s", res.image_id, exc_info=True)
    return True


def remove_single_image(library_id: str, image_id: str) -> None:
    """Remove one image the watcher observed as deleted (file no longer on
    disk). Mirrors the full scan's stale-reconciliation for a single id.

    Resolves ``image_id`` through the same slash/backslash-tolerant lookup as
    every other id-based operation (`image_tags.resolve_image_id_sync`), so a row
    whose stored id spells its separator differently than the watcher's
    freshly-computed id (e.g. written by an older scan on a different OS)
    still gets found instead of silently left behind.
    """
    with sync_conn() as conn:
        resolved_id = image_tags.resolve_image_id_sync(conn, image_id)
    if resolved_id is None:
        return
    with sync_tx() as conn:
        keys = image_delete.delete_rows(conn, [resolved_id])
        _touch_library(conn, library_id, indexed_delta=-1)
    tag_index.invalidate()
    image_delete.drop_thumbs(keys)
