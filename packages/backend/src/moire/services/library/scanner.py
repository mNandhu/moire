from __future__ import annotations
import os
import random
from pathlib import Path
import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ...core import memory
from ...database.db import checkpoint_wal, sync_conn, sync_tx
from ...database import schema as t
from .. import activity
from ..tags import image_tags, index as tag_index
from ..metadata import workflow_identity
from . import batch_pool
from . import nesting as library_nesting
from . import scan_reconcile, thumbnailer
from .scan_writer import ScanWriter, retry
from .storage_fs import (
    delete_thumb,
    put_thumb,
    thumb_key as derived_thumb_key,
    thumb_path,
)
import logging
from dataclasses import dataclass
from datetime import datetime
from multiprocessing import cpu_count
import threading
from threading import Lock
import time

from ...core.config import settings

logger = logging.getLogger("moire.scanner")


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
    """Insert payload for one scanned image: file metadata + initial tag-state
    and its shuffle key. None of those are in ``_SCANNER_IMG_COLS``, so a
    rescan leaves them as they are."""
    return {**doc, **image_tags.initial_tag_fields(), "shuffle_key": random.random()}


def image_upsert_stmt():
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


def _gen_raw_rev_stmt():
    # Every write gives the raw a revision it never had (a missing stamp row
    # reads as 0) and clears the skip stamp, so reprojection re-derives the
    # row and can't stamp a raw it never read (services/metadata/reproject.py).
    stmt = sqlite_insert(t.image_gen_derived).values(
        _id=sa.bindparam("b_id"), raw_rev=sa.bindparam("b_rev"), derive_key=None
    )
    return stmt.on_conflict_do_update(
        index_elements=[t.image_gen_derived.c._id],
        set_={"raw_rev": stmt.excluded.raw_rev, "derive_key": None},
    )


# The next raw revision: one counter for every row, so a raw deleted (its
# stamp row with it) and written again still gets a revision it never had.
_NEXT_REV = sa.text(
    "INSERT INTO gen_raw_revision (id, rev) VALUES (1, 1) "
    "ON CONFLICT(id) DO UPDATE SET rev = rev + 1"
)
_READ_REV = sa.text("SELECT rev FROM gen_raw_revision WHERE id = 1")


def write_gen_raws(conn, rows: list[dict]) -> None:
    """Upsert raw-gen rows (:func:`gen_raw_values` shape) on the caller's
    sync transaction. The only way to write ``image_gen_raw``: each write
    also gives the rows a new revision and clears their reprojection skip
    stamps. One revision per call is enough: it is new to each of them."""
    if not rows:
        return
    stmt = _gen_raw_upsert_stmt()
    for row in rows:
        conn.execute(stmt, row)
    conn.execute(_NEXT_REV)
    rev = conn.execute(_READ_REV).scalar_one()
    conn.execute(
        _gen_raw_rev_stmt(), [{"b_id": row["_id"], "b_rev": rev} for row in rows]
    )


def gen_raw_values(gen_raw_doc: dict) -> dict:
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


def any_scanning() -> bool:
    """Whether a full scan is running in any library."""
    with _scan_lock:
        return bool(_current_scans)


def nudge_auto_tag() -> None:
    """Images may have arrived: auto-tag (if on) queues them once no scan
    runs. Imported late: the job manager reads ``any_scanning`` from here."""
    try:
        from ..ai.jobs import get_ai_job_manager

        get_ai_job_manager().nudge()
    except Exception:
        logger.debug("Could not nudge auto-tag", exc_info=True)


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


def process_image(
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
        thumb_bytes, blurhash, width, height, gen_raw = thumbnailer.make_thumb_bytes(p)

        # Upload thumbnail if generated (optional)
        thumb_key = None
        if thumb_bytes is not None:

            def _upload_thumb():
                return put_thumb(library_id, image_id, thumb_bytes)

            try:
                thumb_key = retry(
                    _upload_thumb,
                    attempts=3,
                    base_delay_s=0.2,
                )
            except Exception:
                # Best-effort: keep image indexed even if thumb failed.
                thumb_key = None
        if thumb_key is None:
            # The row will say there is no thumbnail, but the route serves what
            # is at the derived key without asking the DB: an earlier scan's
            # picture must not stay there.
            try:
                delete_thumb(derived_thumb_key(image_id))
            except (OSError, ValueError):
                logger.debug("Could not delete stale thumb of %s", image_id)

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
                workflow_identity.workflow_sig(gen_raw.get("prompt"))
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


def scan_workers() -> int:
    """Threads decoding files for a scan (or a watcher batch). Scanning is
    I/O + CPU heavy and competes with API traffic, so keep auto-concurrency
    conservative. While tagging or face detection runs the pool takes about
    half the cores, so the tagger's decoding and prefetch keep the rest (a
    full pool starved the GPU: 72% busy down to 40%)."""
    cores = cpu_count() or 4
    default_workers = max(2, min(16, cores))
    cap = settings.scanner_max_workers
    workers = default_workers if not cap or cap <= 0 else min(default_workers, cap)
    if _ai_job_active():
        workers = min(workers, max(2, cores // 2))
    return workers


def _ai_job_active() -> bool:
    from ..ai.jobs import heavy_active

    try:
        return heavy_active()
    except Exception:
        return False


class _Cancelled(Exception):
    """The scan was cancelled (or its library deleted while it was queued)."""


def _check_cancel(library_id: str) -> None:
    if _is_cancel_requested(library_id):
        raise _Cancelled()


def _acquire_slot(library_id: str) -> None:
    """Wait for a scan slot; raises `_Cancelled` if cancelled while queued.
    On return the caller owns the slot and must release it."""
    while not _scan_slots.acquire(timeout=0.5):
        _check_cancel(library_id)
    try:
        _check_cancel(library_id)
    except _Cancelled:
        _scan_slots.release()
        raise


def _current_root(library_id: str) -> Path:
    """Where the library lives now. A queued scan may have waited minutes; if
    the library was moved meanwhile (a re-scan request was a no-op while this
    was queued), scan where it lives now rather than the path captured at
    enqueue."""
    with sync_conn() as conn:
        current = conn.execute(
            sa.select(t.libraries.c.path).where(t.libraries.c._id == library_id)
        ).scalar()
    if current is None:
        raise _Cancelled()  # library deleted while queued
    root_path = Path(current)
    # os.walk of a missing root yields nothing without raising, which would
    # make every image look deleted: fail the scan instead.
    if not root_path.is_dir():
        raise RuntimeError(f"Library folder not found: {root_path}")
    return root_path


def _walk(
    library_id: str, root_path: Path, nested: list[str]
) -> tuple[list[Path], set[str], list[OSError]]:
    """Discover image files under the root, skipping nested libraries' folders.
    Folders the walk cannot read are returned as errors, so their images are
    kept rather than reconciled away as deleted (`unread_prefixes`)."""
    files: list[Path] = []
    discovered: set[str] = set()
    walk_errors: list[OSError] = []
    for dirpath, dirnames, filenames in os.walk(root_path, onerror=walk_errors.append):
        dirnames[:] = library_nesting.skip_dirs(dirpath, dirnames, nested)
        for fname in filenames:
            p = Path(dirpath) / fname
            if thumbnailer.is_image(p):
                files.append(p)
            elif not (
                thumbnailer.is_ignored(p) and p.suffix.lower() in thumbnailer.IMAGE_EXTS
            ):
                continue
            # An ignored image is never indexed, but a row a scan wrote before
            # the ignore rule existed may hold tags: keep it while the file does.
            try:
                discovered.add(image_id_for(library_id, root_path, p))
            except Exception as e:
                # No filename, so it guards the whole library.
                walk_errors.append(OSError(str(e)))
    return files, discovered, walk_errors


def _load_known(library_id: str, stamp: str) -> Known | None:
    """The library's rows a scan may skip when their file is unchanged, or
    None when the last full scan used a different stamp (rebuild all)."""
    last_stamp, retry = scan_reconcile.load_stamp(library_id)
    if last_stamp != stamp:
        return None
    with sync_conn() as conn:
        return {
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


def _commit_batch(imgs: list[dict], raws: list[dict]) -> None:
    # One short write transaction per batch keeps the SQLite write lock held
    # briefly so concurrent API writes aren't starved. Image rows and their
    # raw-gen rows commit together.
    def _do_flush():
        with sync_tx() as conn:
            write_gen_raws(conn, raws)
            if imgs:
                stmt = image_upsert_stmt()
                for row in imgs:
                    conn.execute(stmt, row)

    retry(_do_flush, attempts=3, base_delay_s=0.2)


# A scan leaving more than this share of the library's raws to derive reprojects
# the whole library: its paged read of the raw table beats looking up that many ids
# in 500-id chunks, and a first scan (every raw new) always lands here.
_LIBRARY_REPROJECT_SHARE = 0.5


def _after_scan(library_id: str, *, written_raw_ids: set[str]) -> None:
    """Follow-ups that must not fail the scan: fold nested copies, then derive
    gen.* from the raw just captured.

    ``written_raw_ids``: images whose raw generation data this scan wrote (new
    or modified files; a touched file is reopened and its raw rewritten even
    when identical, so it is included and the reprojection's own unchanged-row
    skip handles it). Skipped rows kept their gen data."""
    # Fold any outer library's copies of files into their innermost library:
    # this one's own (now that it has indexed them and finished), or those of
    # the libraries inside it. A no-op without nesting.
    try:
        library_nesting.adopt_nested_copies()
    except Exception:
        logger.warning("Folding nested library copies failed", exc_info=True)

    # Spawned in its own thread so the scan slot frees immediately (a long
    # reproject must not make the library look "still scanning" / block a
    # rescan). Only the rows this scan wrote raw for, plus rows a reprojection
    # never reached (one cut off by a restart, or raws an earlier scan
    # rewrote that were never derived: their stamp is cleared), need deriving.
    try:
        from ..metadata.reproject import (
            reproject_ids_async,
            reproject_library_async,
            underived_ids,
            unstamped_ids,
        )

        stale = written_raw_ids | set(unstamped_ids(library_id))
        # A library run derives exactly the stale rows too, by a paged read;
        # it also takes an upgraded DB's first rescan (no row stamped yet).
        if stale and _mostly_rewritten(library_id, len(stale)):
            reproject_library_async(library_id)
        elif ids := sorted(stale | set(underived_ids(library_id))):
            reproject_ids_async(ids)
    except Exception:
        # Reprojection is re-runnable via the manual endpoint.
        logger.warning(
            "Post-scan reprojection failed to start for library %s",
            library_id,
            exc_info=True,
        )


def _mostly_rewritten(library_id: str, written: int) -> bool:
    with sync_conn() as conn:
        total = conn.execute(
            sa.select(sa.func.count())
            .select_from(t.image_gen_raw)
            .where(t.image_gen_raw.c.library_id == library_id)
        ).scalar_one()
    return written > total * _LIBRARY_REPROJECT_SHARE


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
        nonlocal root_path
        processed = 0
        skipped = 0
        failed = 0
        failed_samples: list[dict] = []
        scan_note: str | None = None
        has_slot = False
        # Whether a batch committed: the views over images (tag lists, facet
        # counts, signatures) are invalidated once, when the scan ends.
        wrote = False
        try:
            _acquire_slot(library_id)
            has_slot = True
            root_path = _current_root(library_id)

            # Leave out the folders of libraries inside this one: their files
            # are theirs (services/library/nesting).
            nested = library_nesting.nested_roots(library_id, root_path)
            files, discovered_image_ids, walk_errors = _walk(
                library_id, root_path, nested
            )
            _lib_set(library_id, {"scan_total": len(files), "scan_done": 0})
            _check_cancel(library_id)

            # Rows a previous scan wrote with the current thumbnail settings
            # can be skipped when their file is unchanged. With a different
            # stamp (or none yet) every file is rebuilt.
            stamp = thumbnailer.thumb_stamp()
            known = _load_known(library_id, stamp)

            workers = scan_workers()
            progress_interval_s = max(
                0.1,
                settings.scan_progress_update_ms / 1000.0,
            )
            last_progress_write = time.monotonic()

            # Image ids whose raw gen data was committed. Filled by the
            # writer's sink, which only the (single) completion thread drives.
            written_raw_ids: set[str] = set()

            def _commit(imgs: list[dict], raws: list[dict]) -> None:
                nonlocal wrote
                _commit_batch(imgs, raws)
                wrote = True
                written_raw_ids.update(r["_id"] for r in raws)

            writer = ScanWriter(_commit, batch_size=200)
            failed_ids: list[str] = []

            def _on_complete(res, exc) -> None:
                nonlocal processed, skipped, failed, last_progress_write
                if isinstance(res, _ScanResult) and res.skipped:
                    skipped += 1
                elif isinstance(res, _ScanResult) and res.ok and res.doc:
                    writer.add(
                        image_upsert_values(res.doc),
                        gen_raw_values(res.gen_raw_doc)
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
                lambda p: process_image(library_id, root_path, p, known),
                _on_complete,
                max_workers=workers,
                is_cancelled=lambda: _is_cancel_requested(library_id),
            )
            _check_cancel(library_id)

            writer.flush()
            indexed = writer.indexed + skipped

            scan_note = scan_reconcile.reconcile(
                library_id, root_path, nested, discovered_image_ids, walk_errors
            )
            scan_reconcile.save_stamp(library_id, stamp, failed_ids)
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
            _after_scan(library_id, written_raw_ids=written_raw_ids)
        except _Cancelled:
            logger.info("Scan cancelled for library %s", library_id)
            _lib_set(library_id, {"scanning": False, "scan_error": "cancelled"})
        except Exception as e:
            logger.exception("Scan failed for library %s", library_id)
            _lib_set(library_id, {"scanning": False, "scan_error": str(e)})
        finally:
            if wrote:
                # After the last commit, cancelled or failed too. Strict: a
                # scan's new images are what its user waits to see.
                tag_index.invalidate()
            if has_slot:
                _scan_slots.release()
            activity.note_ended("scan")
            # The scan's decode buffers are freed but glibc holds the pages.
            memory.trim()
            with _scan_lock:
                _current_scans.discard(library_id)
                _cancel_scans.discard(library_id)
                _scan_threads.pop(library_id, None)
                again = library_id in _rescan_after
                _rescan_after.discard(library_id)
            # Truncate the WAL the scan grew (busy if a reprojection it
            # started is writing: that run checkpoints when it ends).
            checkpoint_wal()
            nudge_auto_tag()
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
    while True:
        with _scan_lock:
            if library_id in _current_scans:
                _rescan_after.add(library_id)
                _cancel_scans.add(library_id)
                return {"started": False, "status": "restarting"}
        result = scan_library_async(library_id, root)
        if result.get("started"):
            return result
        # A scan began (or ended) between the check and the start: look again.


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
        # A user cancel also drops a pending move-restart.
        _rescan_after.discard(library_id)
        th = _scan_threads.get(library_id)

    # Best-effort: give the scan thread a moment to notice cancellation.
    if th is not None and th.is_alive():
        th.join(timeout=max(0.0, float(join_timeout_s)))
    return True
