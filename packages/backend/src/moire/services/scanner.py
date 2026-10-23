from __future__ import annotations
import os
from pathlib import Path
from io import BytesIO
from PIL import Image as PILImage
import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import sync_conn, sync_tx
from ..database import schema as t
from . import image_tags
from . import tag_index
from . import gen_metadata
from . import batch_pool
from . import library_nesting
from .scan_writer import ScanWriter
from .storage_fs import put_thumb, thumb_path
from .blurhash import blurhash_for_image
import hashlib
import logging
import mimetypes
from dataclasses import dataclass
from datetime import datetime
from multiprocessing import cpu_count
import threading
from threading import Lock
import time

from ..core.config import settings

logger = logging.getLogger("moire.scanner")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

_THUMB_QUALITY = 85
# Bump when the thumbnail encoding changes in code (resampling, encoder
# options) so existing thumbnails are rebuilt on the next scan.
_THUMB_RECIPE = 1


def thumb_stamp() -> str:
    """Everything a scan derives from a file: the thumbnail recipe and the
    generation-metadata capture. A rescan skips unchanged files only while
    the library's last full scan ran with this same stamp, so changing the
    size/format settings, `_THUMB_RECIPE` or `gen_metadata.CAPTURE_VERSION`
    re-reads every file."""
    size = max(16, settings.thumb_max_size)
    return (
        f"{size}/{settings.thumb_format.lower()}/q{_THUMB_QUALITY}/r{_THUMB_RECIPE}"
        f"/c{gen_metadata.CAPTURE_VERSION}"
    )


def _stamp_row(library_id: str) -> str:
    return f"thumbs:{library_id}"


# How many failed ids a stamp remembers; past it, the next scan rebuilds all.
_MAX_RETRY_IDS = 5000


def _load_stamp(library_id: str) -> tuple[str | None, set[str]]:
    """The library's last full-scan stamp and the ids that failed in it."""
    with sync_conn() as conn:
        doc = conn.execute(
            sa.select(t.app_settings.c.doc).where(
                t.app_settings.c._id == _stamp_row(library_id)
            )
        ).scalar()
    doc = doc or {}
    return doc.get("stamp"), set(doc.get("retry") or [])


def _save_stamp(library_id: str, stamp: str | None, retry: list[str]) -> None:
    """Record a finished scan. Files that failed in it kept whatever row an
    earlier scan wrote (maybe with an older thumbnail recipe or capture), so
    they are listed for the next scan to re-read rather than skip; too many
    to list, and the stamp is dropped so the next scan re-reads everything."""
    if len(retry) > _MAX_RETRY_IDS:
        stamp, retry = None, []
    doc = {"stamp": stamp, "retry": retry}
    with sync_tx() as conn:
        stmt = sqlite_insert(t.app_settings).values(_id=_stamp_row(library_id), doc=doc)
        conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[t.app_settings.c._id], set_={"doc": doc}
            )
        )


def _make_thumb_bytes(
    path: Path,
) -> tuple[bytes | None, str | None, int, int, dict | None]:
    """Render thumbnail bytes, a BlurHash placeholder, original dimensions, and
    embedded generation metadata from a single image open.

    Returns ``(thumb_bytes, blurhash, width, height, gen_raw)``; thumb/blurhash
    may be None on failure, dimensions 0 if the header couldn't be read, gen_raw
    None when the image carries no generation data.
    """
    try:
        with PILImage.open(path) as img:
            # Original dimensions come from the header (no full decode), read
            # them before draft()/thumbnail() shrink the in-memory image.
            width, height = img.size

            # Capture embedded generation metadata from the same open. The
            # format knowledge lives in gen_metadata, which owns both halves.
            gen_raw = gen_metadata.read_gen_raw(img)

            size = max(16, settings.thumb_max_size)
            # draft() lets the JPEG decoder emit a pre-shrunk image (1/2, 1/4,
            # 1/8 scale), so large sources decode several times faster. No-op
            # for non-JPEG formats.
            img.draft("RGB", (size, size))
            img.thumbnail((size, size))

            buf = BytesIO()
            fmt = settings.thumb_format.upper()
            if fmt == "WEBP":
                img.save(buf, format="WEBP", quality=_THUMB_QUALITY)
            else:
                img.convert("RGB").save(buf, format=fmt, quality=_THUMB_QUALITY)

            # BlurHash from the already-downsampled thumbnail (it shrinks to
            # ~64px internally, so the result is identical to encoding the
            # full-res image but far cheaper).
            bh = blurhash_for_image(img)
            return buf.getvalue(), bh, int(width), int(height), gen_raw
    except Exception:
        return None, None, 0, 0, None


def is_image(path: Path) -> bool:
    if path.suffix.lower() in IMAGE_EXTS:
        return True
    mt, _ = mimetypes.guess_type(str(path))
    return mt is not None and mt.startswith("image/")


def file_hash(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _retry(
    fn,
    *,
    attempts: int = 3,
    base_delay_s: float = 0.2,
    retry_exceptions: tuple[type[BaseException], ...] = (Exception,),
):
    last: BaseException | None = None
    for i in range(max(1, int(attempts))):
        try:
            return fn()
        except retry_exceptions as e:  # type: ignore[misc]
            last = e
            if i >= attempts - 1:
                break
            # Exponential backoff with a small cap
            delay = min(2.0, base_delay_s * (2**i))
            time.sleep(delay)
    assert last is not None
    raise last


def image_id_for(library_id: str, root_path: Path, p: Path) -> str:
    """Stable image id: ``{library_id}:{path-relative-to-library-root}``."""
    return f"{library_id}:{p.relative_to(root_path)}"


# File-metadata columns the scanner refreshes on every pass. Tag-state columns
# (tags/has_*/quarantined/score) are seeded only on insert and left untouched on
# conflict: the SQLite equivalent of the old `$setOnInsert`.
_SCANNER_IMG_COLS = (
    "library_id",
    "path",
    "size",
    "width",
    "height",
    "ctime",
    "mtime",
    "thumb_key",
    "blurhash",
)


def image_upsert_values(doc: dict) -> dict:
    """Insert payload for one scanned image: file metadata + initial tag-state."""
    return {**doc, **image_tags.initial_tag_fields()}


def _image_upsert_stmt():
    stmt = sqlite_insert(t.images)
    return stmt.on_conflict_do_update(
        index_elements=[t.images.c._id],
        set_={c: stmt.excluded[c] for c in _SCANNER_IMG_COLS},
    )


def _gen_raw_upsert_stmt():
    stmt = sqlite_insert(t.image_gen_raw)
    return stmt.on_conflict_do_update(
        index_elements=[t.image_gen_raw.c._id],
        set_={
            "library_id": stmt.excluded.library_id,
            "workflow_sig": stmt.excluded.workflow_sig,
            "raw": stmt.excluded.raw,
        },
    )


def _gen_raw_values(gen_raw_doc: dict) -> dict:
    """Split the captured gen-raw doc into the cold-table row shape."""
    meta = {"_id", "library_id", "workflow_sig"}
    raw = {k: v for k, v in gen_raw_doc.items() if k not in meta}
    return {
        "_id": gen_raw_doc["_id"],
        "library_id": gen_raw_doc["library_id"],
        "workflow_sig": gen_raw_doc.get("workflow_sig"),
        "raw": raw,
    }


def _lib_set(library_id: str, values: dict) -> None:
    """Apply a small library-progress update in its own short write transaction."""
    with sync_tx() as conn:
        conn.execute(
            sa.update(t.libraries)
            .where(t.libraries.c._id == library_id)
            .values(**values)
        )


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

    Mirrors one iteration of the full scan (`_process_image` + the same
    upsert statements) without touching any other row, the incremental
    counterpart to `scan_library_async`'s batch walk. Returns ``True`` on
    success (including "not an image, skipped").
    """
    if not is_image(path):
        return True
    res = _process_image(library_id, root_path, path)
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
            conn.execute(_gen_raw_upsert_stmt(), _gen_raw_values(res.gen_raw_doc))
        conn.execute(_image_upsert_stmt(), image_upsert_values(res.doc))
        _touch_library(conn, library_id, indexed_delta=0 if existed else 1)
    # A brand-new row carries no gen data to reproject over, but a modified
    # file may have replaced its embedded metadata, so re-deriving is always safe.
    if res.gen_raw_doc is not None:
        try:
            from .reproject import reproject_image

            reproject_image(res.image_id)
        except Exception:
            pass
    return True


def remove_single_image(library_id: str, image_id: str) -> None:
    """Remove one image the watcher observed as deleted (file no longer on
    disk). Mirrors the full scan's stale-reconciliation for a single id.

    Resolves ``image_id`` through the same slash/backslash-tolerant lookup as
    every other id-based operation (`image_tags.id_candidates`), so a row
    whose stored id spells its separator differently than the watcher's
    freshly-computed id (e.g. written by an older scan on a different OS)
    still gets found instead of silently left behind.
    """
    from . import image_tags

    with sync_conn() as conn:
        resolved_id = None
        thumb_key = None
        for candidate in image_tags.id_candidates(image_id):
            row = conn.execute(
                sa.select(t.images.c._id, t.images.c.thumb_key).where(
                    t.images.c._id == candidate
                )
            ).first()
            if row is not None:
                resolved_id, thumb_key = row._id, row.thumb_key
                break
    if resolved_id is None:
        return
    with sync_tx() as conn:
        conn.execute(sa.delete(t.images).where(t.images.c._id == resolved_id))
        conn.execute(
            sa.delete(t.image_gen_raw).where(t.image_gen_raw.c._id == resolved_id)
        )
        _touch_library(conn, library_id, indexed_delta=-1)
    tag_index.invalidate()
    if thumb_key:
        try:
            from .storage_fs import delete_thumb

            delete_thumb(thumb_key)
        except Exception:
            pass


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


# --- Async scanning with progress tracking ---
_scan_lock = Lock()
# Caps how many libraries scan at once. Each scan already fans out over a thread
# pool and SQLite has one writer, so adding a dozen libraries in one go should
# queue them, not run them all at once. A queued library shows `scanning` 0/0.
_scan_slots = threading.BoundedSemaphore(max(1, settings.scanner_max_concurrent_scans))
_current_scans: set[str] = set()
_cancel_scans: set[str] = set()
_scan_threads: dict[str, threading.Thread] = {}
# Libraries moved mid-scan: the scan is cancelled and started afresh on its way out.
_rescan_after: set[str] = set()
# Scans that have ended, however (the activity poll's "ended" count).
_scans_ended = 0


def scans_ended() -> int:
    with _scan_lock:
        return _scans_ended


def _is_cancel_requested(library_id: str) -> bool:
    with _scan_lock:
        return library_id in _cancel_scans


def is_scanning(library_id: str) -> bool:
    """Whether a full scan currently owns this library's rows.

    The watcher checks this before touching a library: a running scan's
    ``discovered_image_ids`` set is fixed at walk time, so an incremental
    ingest/delete racing it could be undone by the scan's stale-reconciliation
    (or duplicate work the scan is already doing). Skipping here is safe; the
    scan itself reflects disk state as of its walk, and the periodic
    reconciliation rescan is the backstop for anything that changed mid-scan.
    """
    with _scan_lock:
        return library_id in _current_scans


@dataclass
class _ScanResult:
    image_id: str
    ok: bool
    doc: dict | None = None
    gen_raw_doc: dict | None = None
    error: str | None = None
    stage: str | None = None
    # Unchanged since the last scan; nothing to write.
    skipped: bool = False


# image id -> (path, size, mtime, thumb_key) of the row a previous scan wrote.
Known = dict[str, tuple[str | None, int | None, float | None, str | None]]


def _unchanged(
    known: Known | None, image_id: str, p: Path, stat: os.stat_result
) -> bool:
    prev = known.get(image_id) if known else None
    if prev is None:
        return False
    path, size, mtime, thumb_key = prev
    # Ids are relative to the library root, so a moved library matches every
    # id; its rows still need the new absolute path.
    return (
        path == str(p)
        and size == stat.st_size
        and mtime == stat.st_mtime
        and thumb_key is not None
        and thumb_path(thumb_key) is not None
    )


def _process_image(
    library_id: str, root_path: Path, p: Path, known: Known | None = None
) -> _ScanResult:
    """Process a single image file.

    This function performs file inspection + thumbnail write to the FS.
    DB writes are performed in batches by the scan coordinator thread.
    Originals are served directly from the filesystem (Local Mount mode).
    A file whose size and mtime match its row in ``known`` (and whose thumbnail
    is still on disk) is skipped without opening it. The stat runs here, on
    the pool, because each one is a slow round trip on network mounts.
    """
    image_id = f"{library_id}:<unknown>"
    try:
        image_id = image_id_for(library_id, root_path, p)
        stat = p.stat()
        if _unchanged(known, image_id, p, stat):
            return _ScanResult(image_id=image_id, ok=True, skipped=True)
        # Single decode yields the thumbnail, BlurHash placeholder, the original
        # dimensions (read from the header before downscaling), and any embedded
        # generation metadata.
        thumb_bytes, blurhash, width, height, gen_raw = _make_thumb_bytes(p)

        # Upload thumbnail if generated (optional)
        thumb_key = None
        if thumb_bytes is not None:

            def _upload_thumb():
                return put_thumb(library_id, image_id, thumb_bytes)

            try:
                thumb_key = _retry(
                    _upload_thumb,
                    attempts=3,
                    base_delay_s=0.2,
                )
            except Exception:
                # Best-effort: keep image indexed even if thumb failed.
                thumb_key = None

        doc = {
            "_id": image_id,
            "library_id": library_id,
            "path": str(p),
            "size": stat.st_size,
            "width": width,
            "height": height,
            "ctime": stat.st_ctime,
            "mtime": stat.st_mtime,
            "thumb_key": thumb_key,
            "blurhash": blurhash,
        }
        # Store embedded generation data verbatim in the cold collection (keyed
        # by image id). Structured `gen.*` is derived later by reprojection; the
        # scan never parses, only captures + computes the workflow signature.
        gen_raw_doc = None
        if gen_raw is not None:
            sig = (
                gen_metadata.workflow_sig(gen_raw.get("prompt"))
                if gen_raw.get("source") == "comfyui"
                else None
            )
            gen_raw_doc = {
                "_id": image_id,
                "library_id": library_id,
                "workflow_sig": sig,
                **gen_raw,
            }
        return _ScanResult(image_id=image_id, ok=True, doc=doc, gen_raw_doc=gen_raw_doc)
    except Exception as e:
        # Includes stat/path errors
        logger.warning("Failed to process %s: %s", p, e)
        return _ScanResult(
            image_id=image_id,
            ok=False,
            error=str(e),
            stage="process",
        )


def scan_library_async(library_id: str, root: str) -> dict:
    """Kick off a background multithreaded scan with progress. Returns status."""
    root_path = Path(root)
    with _scan_lock:
        if library_id in _current_scans:
            return {"started": False, "status": "already_running"}
        _current_scans.add(library_id)
        _cancel_scans.discard(library_id)

    # Initialize progress fields
    _lib_set(
        library_id,
        {
            "scanning": True,
            "scan_total": 0,
            "scan_done": 0,
            "scan_error": None,
            "scan_failed_count": 0,
            "scan_failed_samples": [],
        },
    )

    def _run():
        global _scans_ended
        nonlocal library_id, root_path
        total = 0
        processed = 0
        indexed = 0
        skipped = 0
        failed = 0
        failed_samples: list[dict] = []
        discovered_image_ids: set[str] = set()
        scan_note: str | None = None
        has_slot = False
        try:
            while not _scan_slots.acquire(timeout=0.5):
                with _scan_lock:
                    if library_id in _cancel_scans:
                        raise RuntimeError("cancelled")
            has_slot = True
            with _scan_lock:
                if library_id in _cancel_scans:
                    raise RuntimeError("cancelled")
            # A queued scan may have waited minutes; if the library was moved
            # meanwhile (a re-scan request was a no-op while this was queued),
            # scan where it lives now rather than the path captured at enqueue.
            with sync_conn() as conn:
                current = conn.execute(
                    sa.select(t.libraries.c.path).where(t.libraries.c._id == library_id)
                ).scalar()
            if current is None:
                raise RuntimeError("cancelled")  # library deleted while queued
            root_path = Path(current)
            # os.walk of a missing root yields nothing without raising, which
            # would make every image look deleted: fail the scan instead.
            if not root_path.is_dir():
                raise RuntimeError(f"Library folder not found: {root_path}")

            # Discover image files, leaving out the folders of libraries
            # inside this one: their files are theirs (services/library_nesting).
            # Folders the walk cannot read are recorded, so their images are
            # kept rather than reconciled away as deleted (unread_prefixes).
            nested = library_nesting.nested_roots(library_id, root_path)
            files: list[Path] = []
            walk_errors: list[OSError] = []
            for dirpath, dirnames, filenames in os.walk(
                root_path, onerror=walk_errors.append
            ):
                dirnames[:] = library_nesting.skip_dirs(dirpath, dirnames, nested)
                for fname in filenames:
                    p = Path(dirpath) / fname
                    if is_image(p):
                        files.append(p)
                        try:
                            discovered_image_ids.add(
                                image_id_for(library_id, root_path, p)
                            )
                        except Exception as e:
                            # No filename, so it guards the whole library.
                            walk_errors.append(OSError(str(e)))
            total = len(files)
            _lib_set(library_id, {"scan_total": total, "scan_done": 0})

            with _scan_lock:
                if library_id in _cancel_scans:
                    raise RuntimeError("cancelled")

            # Rows a previous scan wrote with the current thumbnail settings
            # can be skipped when their file is unchanged. With a different
            # stamp (or none yet) every file is rebuilt.
            stamp = thumb_stamp()
            known: Known | None = None
            last_stamp, retry = _load_stamp(library_id)
            if last_stamp == stamp:
                with sync_conn() as conn:
                    known = {
                        r._id: (r.path, r.size, r.mtime, r.thumb_key)
                        for r in conn.execute(
                            sa.select(
                                t.images.c._id,
                                t.images.c.path,
                                t.images.c.size,
                                t.images.c.mtime,
                                t.images.c.thumb_key,
                            ).where(t.images.c.library_id == library_id)
                        )
                        if r._id not in retry
                    }

            # Multithreaded processing (cap via config if provided)
            # Scanning is I/O + CPU heavy and competes with API traffic and the Mongo pool,
            # so keep auto-concurrency conservative.
            default_workers = max(2, min(16, (cpu_count() or 4)))
            cap = settings.scanner_max_workers
            workers = (
                default_workers if not cap or cap <= 0 else min(default_workers, cap)
            )
            progress_interval_s = max(
                0.1,
                settings.scan_progress_update_ms / 1000.0,
            )
            last_progress_write = time.monotonic()

            def _commit_batch(imgs: list[dict], raws: list[dict]) -> None:
                # One short write transaction per batch keeps the SQLite write lock
                # held briefly so concurrent API writes aren't starved. Image rows
                # and their raw-gen rows commit together.
                def _do_flush():
                    with sync_tx() as conn:
                        if raws:
                            stmt = _gen_raw_upsert_stmt()
                            for row in raws:
                                conn.execute(stmt, row)
                        if imgs:
                            stmt = _image_upsert_stmt()
                            for row in imgs:
                                conn.execute(stmt, row)

                _retry(_do_flush, attempts=3, base_delay_s=0.2)

            writer = ScanWriter(_commit_batch, batch_size=200)
            failed_ids: list[str] = []

            def _on_complete(res, exc) -> None:
                nonlocal processed, skipped, failed, last_progress_write
                if isinstance(res, _ScanResult) and res.skipped:
                    skipped += 1
                elif isinstance(res, _ScanResult) and res.ok and res.doc:
                    writer.add(
                        image_upsert_values(res.doc),
                        _gen_raw_values(res.gen_raw_doc)
                        if res.gen_raw_doc is not None
                        else None,
                    )
                else:
                    failed += 1
                    if isinstance(res, _ScanResult):
                        failed_ids.append(res.image_id)
                    if isinstance(res, _ScanResult) and len(failed_samples) < 20:
                        failed_samples.append(
                            {
                                "image_id": res.image_id,
                                "stage": res.stage,
                                "error": res.error,
                            }
                        )
                processed += 1

                # Time-based progress persistence: smooth UI without spamming DB.
                now = time.monotonic()
                if (now - last_progress_write) >= progress_interval_s:
                    last_progress_write = now
                    _lib_set(
                        library_id,
                        {
                            "scan_done": processed,
                            "scan_failed_count": failed,
                            "scan_failed_samples": failed_samples,
                        },
                    )

            batch_pool.run_pool(
                files,
                lambda p: _process_image(library_id, root_path, p, known),
                _on_complete,
                max_workers=workers,
                is_cancelled=lambda: _is_cancel_requested(library_id),
            )

            with _scan_lock:
                if library_id in _cancel_scans:
                    raise RuntimeError("cancelled")

            # Flush the remaining partial batch.
            writer.flush()
            indexed = writer.indexed + skipped

            # Clean up stale images (images that exist in DB but weren't discovered in current scan)
            with sync_conn() as conn:
                existing = conn.execute(
                    sa.select(
                        t.images.c._id, t.images.c.path, t.images.c.thumb_key
                    ).where(t.images.c.library_id == library_id)
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
            stale_image_ids, stale_thumb_keys = reconcile_stale(
                discovered_image_ids, existing_docs, unread
            )
            keep_reason = stale_guard(
                root_path, len(discovered_image_ids), len(existing_docs)
            )
            if keep_reason and stale_image_ids:
                logger.warning(
                    "Scan of library %s kept %d missing images: %s",
                    library_id,
                    len(stale_image_ids),
                    keep_reason,
                )
                scan_note = f"Kept {len(stale_image_ids)} images: {keep_reason}"
                stale_image_ids, stale_thumb_keys = [], []

            # Remove stale images (image_tags / image_gen_terms cascade via FK).
            if stale_image_ids:
                with sync_tx() as conn:
                    conn.execute(
                        sa.delete(t.images).where(t.images.c._id.in_(stale_image_ids))
                    )
                    # Drop their raw generation docs too, else they orphan forever.
                    conn.execute(
                        sa.delete(t.image_gen_raw).where(
                            t.image_gen_raw.c._id.in_(stale_image_ids)
                        )
                    )
                # This tx owns the reconcile, so it owns the post-commit
                # invalidation: the cascade dropped those images' tag rows.
                tag_index.invalidate()

                # Clean up corresponding thumbnail files on disk
                if stale_thumb_keys:
                    try:
                        from .storage_fs import delete_thumb

                        for key in stale_thumb_keys:
                            delete_thumb(key)
                    except Exception:
                        # Best effort cleanup - don't fail the scan if it fails
                        pass

            _save_stamp(library_id, stamp, failed_ids)

            # Finalize
            _lib_set(
                library_id,
                {
                    "scanning": False,
                    "scan_done": processed,
                    "indexed_count": indexed,
                    "last_scanned": datetime.utcnow().isoformat(),
                    "scan_failed_count": failed,
                    "scan_failed_samples": failed_samples,
                    "scan_error": scan_note,
                },
            )

            # Fold any outer library's copies of files into their innermost
            # library: this one's own (now that it has indexed them and finished), or
            # those of the libraries inside it. A no-op without nesting.
            try:
                library_nesting.adopt_nested_copies()
            except Exception:
                logger.warning("Folding nested library copies failed", exc_info=True)

            # Derive structured gen.* from the raw we just captured. Spawned in
            # its own thread so the scan slot frees immediately (a long reproject
            # must not make the library look "still scanning" / block a rescan).
            # Skipped rows kept their gen data, so with nothing rewritten only
            # rows a reprojection never reached (one cut off by a restart) need
            # deriving.
            try:
                from .reproject import (
                    reproject_ids_async,
                    reproject_library_async,
                    underived_ids,
                )

                if writer.indexed:
                    reproject_library_async(library_id)
                elif pending := underived_ids(library_id):
                    reproject_ids_async(pending)
            except Exception:
                # Reprojection is re-runnable via the manual endpoint; never let
                # it fail the scan.
                logger.warning(
                    "Post-scan reprojection failed to start for library %s",
                    library_id,
                    exc_info=True,
                )
        except Exception as e:
            if str(e) == "cancelled":
                logger.info("Scan cancelled for library %s", library_id)
            else:
                logger.exception("Scan failed for library %s", library_id)
            _lib_set(library_id, {"scanning": False, "scan_error": str(e)})
        finally:
            if has_slot:
                _scan_slots.release()
            with _scan_lock:
                _scans_ended += 1
                _current_scans.discard(library_id)
                _cancel_scans.discard(library_id)
                _scan_threads.pop(library_id, None)
                again = library_id in _rescan_after
                _rescan_after.discard(library_id)
            if again:
                # The scan ended (cancelled) because the library moved; it
                # reads the new path itself once it has a slot.
                scan_library_async(library_id, str(root_path))

    # Start background thread. NB: named `th` (not `t`): `t` is the schema-table
    # module alias used inside `_run`, and a local `t` here would shadow it.
    th = threading.Thread(target=_run, name=f"scan-{library_id}", daemon=True)
    with _scan_lock:
        _scan_threads[library_id] = th
    th.start()
    return {"started": True}


def restart_scan(library_id: str, root: str) -> dict:
    """Scan `root` for a library: start a scan, or, when one is already running
    (possibly on the old folder), cancel it and start a fresh one as it ends."""
    with _scan_lock:
        if library_id in _current_scans:
            _rescan_after.add(library_id)
            _cancel_scans.add(library_id)
            return {"started": False, "status": "restarting"}
    result = scan_library_async(library_id, root)
    if not result.get("started"):
        # Lost a race with a scan that began just now: restart it the same way.
        with _scan_lock:
            _rescan_after.add(library_id)
            _cancel_scans.add(library_id)
        return {"started": False, "status": "restarting"}
    return result


def cancel_scan(library_id: str, *, join_timeout_s: float = 0.5) -> bool:
    """Request cancellation of a running scan.

    Returns True if a scan was running (cancellation requested), False otherwise.
    """
    th: threading.Thread | None = None
    with _scan_lock:
        running = library_id in _current_scans
        if not running:
            return False
        _cancel_scans.add(library_id)
        th = _scan_threads.get(library_id)

    # Best-effort: give the scan thread a moment to notice cancellation.
    if th is not None and th.is_alive():
        th.join(timeout=max(0.0, float(join_timeout_s)))
    return True
