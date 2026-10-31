"""What a finished scan records and removes.

The scan stamp (per library: the recipe the last full scan used and the ids
that failed in it) decides what the next scan may skip. Reconciliation
removes images whose files are gone, guarded so an unreadable folder or an
unmounted drive never deletes anything (:func:`stale_guard`,
:func:`unread_prefixes`). Deleting drops tags, ratings and scores, so the
pure policy (:func:`reconcile_stale`) is kept apart and tested on its own.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import sync_conn, sync_tx
from . import app_settings, image_delete, library_nesting, tag_index
from .scan_writer import retry

logger = logging.getLogger("moire.scanner")


def _stamp_row(library_id: str) -> str:
    return f"thumbs:{library_id}"


# How many failed ids a stamp remembers; past it, the next scan rebuilds all.
_MAX_RETRY_IDS = 5000


def load_stamp(library_id: str) -> tuple[str | None, set[str]]:
    """The library's last full-scan stamp and the ids that failed in it."""
    doc = app_settings.read_sync(_stamp_row(library_id))
    doc = doc or {}
    return doc.get("stamp"), set(doc.get("retry") or [])


def save_stamp(library_id: str, stamp: str | None, retry: list[str]) -> None:
    """Record a finished scan. Files that failed in it kept whatever row an
    earlier scan wrote (maybe with an older thumbnail recipe or capture), so
    they are listed for the next scan to re-read rather than skip; too many
    to list, and the stamp is dropped so the next scan re-reads everything."""
    if len(retry) > _MAX_RETRY_IDS:
        stamp, retry = None, []
    doc = {"stamp": stamp, "retry": retry}
    app_settings.write_sync(_stamp_row(library_id), doc)


def reconcile_stale(
    discovered_ids: set[str],
    existing_docs: list[dict],
    unread_prefixes: list[str] | tuple[str, ...] = (),
) -> tuple[list[str], list[str]]:
    """Given the ids seen this scan and the docs already in the DB, return
    ``(stale_image_ids, stale_thumb_keys)``: images that no longer exist on disk.
    Ids under ``unread_prefixes`` (folders the walk could not read) are never stale.

    Pure set math, extracted from the scan loop because it *deletes* images and so
    is the highest-risk part to get wrong.
    """
    stale_ids: list[str] = []
    stale_thumb_keys: list[str] = []
    for doc in existing_docs:
        if doc["_id"] not in discovered_ids and not doc["_id"].startswith(
            tuple(unread_prefixes)
        ):
            stale_ids.append(doc["_id"])
            if doc.get("thumb_key"):
                stale_thumb_keys.append(doc["thumb_key"])
    return stale_ids, stale_thumb_keys


# Stale images are removed this many per transaction, so a big removal never
# holds SQLite's single write lock for the whole run.
_STALE_CHUNK = 500


def _delete_stale(stale_ids: list[str]) -> None:
    """Remove stale images (their tag rows cascade) in small transactions.

    Chunks commit independently, so a failure part-way leaves the earlier
    chunks gone and the rest still indexed; both are consistent (each chunk
    removes an image's rows together), and the next scan finishes the job.
    The tag index is invalidated once after the last chunk, or on the way out
    if one failed, since the chunks that did commit moved tag counts."""
    keys: list[str] = []
    try:
        for i in range(0, len(stale_ids), _STALE_CHUNK):
            chunk = stale_ids[i : i + _STALE_CHUNK]

            def _do(chunk=chunk) -> list[str]:
                with sync_tx() as conn:
                    return image_delete.delete_rows(conn, chunk)

            # A busy database ("database is locked") retries like a batch write.
            chunk_keys = retry(_do, attempts=3, base_delay_s=0.2)
            keys += chunk_keys  # only once the chunk has committed
    finally:
        if stale_ids:
            tag_index.invalidate()
            image_delete.drop_thumbs(keys)


def stale_guard(root_path: Path, discovered: int, existing: int) -> str | None:
    """Why this scan must not delete any stale image, or None when it may.

    Deleting an image drops its tags, ratings and scores, so only a discovery we
    can trust may delete. Not trusted: a root that vanished mid-scan, or a root
    that is suddenly empty while the library has images (an unmounted drive's
    mount point is an empty folder).
    """
    if not root_path.is_dir():
        return "library folder disappeared during the scan"
    if discovered == 0 and existing > 0:
        return "library folder is empty (is the drive connected?)"
    return None


def unread_prefixes(
    library_id: str, root_path: Path, errors: list[OSError]
) -> list[str]:
    """Image-id prefixes of the folders the walk could not read.

    Their images were not seen, not deleted, so they must not count as stale.
    An error without a usable path covers the whole library.
    """
    prefixes: list[str] = []
    for err in errors:
        try:
            rel = Path(err.filename).relative_to(root_path)
        except (TypeError, ValueError):
            return [f"{library_id}:"]
        if rel == Path("."):
            return [f"{library_id}:"]
        prefixes.append(f"{library_id}:{rel}{os.sep}")
    return prefixes


def reconcile(
    library_id: str,
    root_path: Path,
    nested: list[str],
    discovered_image_ids: set[str],
    walk_errors: list[OSError],
) -> str | None:
    """Remove images that exist in the DB but were not discovered. Returns a
    note for the library row when something was kept instead."""
    scan_note: str | None = None
    with sync_conn() as conn:
        existing = conn.execute(
            sa.select(t.images.c._id, t.images.c.path, t.images.c.thumb_key).where(
                t.images.c.library_id == library_id
            )
        ).fetchall()
    # Copies of a nested library's files aren't stale: adopt_nested_copies
    # carries their tags over to that library's rows before dropping them.
    nested_copies = library_nesting.under_nested(
        {r._id: r.path for r in existing}, nested
    )
    existing_docs = [
        {"_id": r._id, "thumb_key": r.thumb_key}
        for r in existing
        if r._id not in nested_copies
    ]

    unread = unread_prefixes(library_id, root_path, walk_errors)
    if unread:
        logger.warning(
            "Scan of library %s could not read %d folders, keeping their images: %s",
            library_id,
            len(walk_errors),
            walk_errors[0],
        )
        scan_note = "Some folders could not be read; their images were kept"
    stale_image_ids, _ = reconcile_stale(discovered_image_ids, existing_docs, unread)
    keep_reason = stale_guard(root_path, len(discovered_image_ids), len(existing_docs))
    if keep_reason and stale_image_ids:
        logger.warning(
            "Scan of library %s kept %d missing images: %s",
            library_id,
            len(stale_image_ids),
            keep_reason,
        )
        scan_note = f"Kept {len(stale_image_ids)} images: {keep_reason}"
        stale_image_ids = []
    _delete_stale(stale_image_ids)
    return scan_note
