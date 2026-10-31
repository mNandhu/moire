"""Reprojection: (re)derive structured ``gen.*`` on image rows from the raw
generation data captured at scan time.

Decoupled from disk scanning. It reads ``image_gen_raw`` (the cold table) and
writes the small structured subdoc (plus the promoted ``gen_*`` filter columns and
the derived ``image_gen_terms`` rows) onto ``images``. Because raw is retained, this
can re-run any time (e.g. after extraction rules change) without re-reading a file.

Sync (SQLAlchemy core) by design: the only callers are scan/manual threads, which
are sync. Writes go through small per-batch transactions to keep the SQLite write
lock held briefly (see :mod:`database.db` writer discipline).
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable, Iterable

import sqlalchemy as sa

from ..database.db import sync_conn, sync_tx
from ..database import schema as t
from . import activity, extraction_settings, gen_metadata
from . import image_tags
from . import tag_index
from .tag_kinds import to_prompt

logger = logging.getLogger("moire.reproject")

_BATCH = 200


def _load_rulesets() -> dict[str, dict]:
    """All user rulesets keyed by workflow signature."""
    with sync_conn() as conn:
        rows = (
            conn.execute(sa.select(t.gen_rulesets.c.sig, t.gen_rulesets.c.doc))
        ).fetchall()
    return {r.sig: (r.doc or {}) for r in rows}


def _flush_batch(batch: list[tuple[str, dict]], *, force: bool = False) -> None:
    """Persist one batch of ``(image_id, gen)`` results in a single small tx,
    one statement per table for the whole batch. Rows whose stored ``gen``
    and tags already match are not written (most of a full reprojection
    after a settings change), unless ``force``: a migration that added a
    derived table needs every row rebuilt even when ``gen`` is unchanged."""
    ids = [image_id for image_id, _ in batch]
    with sync_tx() as conn:
        current = {
            r._id: r
            for r in conn.execute(
                sa.select(t.images.c._id, t.images.c.gen, t.images.c.tags).where(
                    t.images.c._id.in_(ids)
                )
            )
        }
        gens: list[tuple[str, dict]] = []
        tag_items: list[tuple[str, list[str], list[str]]] = []
        for image_id, g in batch:
            row = current.get(image_id)
            if row is None:
                continue  # deleted since the raws were read
            # As stored (JSON round trip), so tuples compare equal to lists.
            g = json.loads(json.dumps(g))
            if force or g != row.gen:
                gens.append((image_id, g))
            # Mirror the extracted terms into prompt: tags (keeping AI + manual).
            prompt_tags = [to_prompt(term) for term in (g.get("prompt_terms") or [])]
            tag_items.append((image_id, list(row.tags or []), prompt_tags))
        if gens:
            _write_gens(conn, gens)
        tagged = image_tags.replace_prompt_many_sync(conn, tag_items, force=force)
    # This batch owns its transaction, so it owns the post-commit invalidation of
    # the derived tag aggregation, once per batch, not once per image.
    if gens or tagged:
        tag_index.invalidate()


def _write_gens(conn, gens: list[tuple[str, dict]]) -> None:
    """``gen``, its promoted columns and its derived rows (prompt terms,
    loras, embeddings) for a batch of images."""
    ids = [image_id for image_id, _ in gens]
    conn.execute(
        sa.update(t.images)
        .where(t.images.c._id == sa.bindparam("b_id"))
        .values(
            gen=sa.bindparam("b_gen", type_=t.images.c.gen.type),
            gen_model=sa.bindparam("b_model"),
            gen_workflow_sig=sa.bindparam("b_sig"),
            gen_group_id=sa.bindparam("b_group"),
            gen_prompt=sa.bindparam("b_prompt"),
        ),
        [
            {
                "b_id": image_id,
                "b_gen": g,
                "b_model": g.get("model"),
                "b_sig": g.get("workflow_sig"),
                "b_group": g.get("group_id"),
                "b_prompt": g.get("prompt"),
            }
            for image_id, g in gens
        ],
    )
    for table in (t.image_gen_terms, t.image_loras, t.image_embeddings):
        conn.execute(sa.delete(table).where(table.c.image_id.in_(ids)))
    terms = [
        {
            "image_id": image_id,
            "term": term,
            "weight": (g.get("prompt_weights") or {}).get(term, 1.0),
        }
        for image_id, g in gens
        for term in dict.fromkeys(g.get("prompt_terms") or [])
    ]
    loras = [
        {"image_id": image_id, "name": lo["name"], "strength": lo.get("strength")}
        for image_id, g in gens
        for lo in g.get("loras") or []
    ]
    embeddings = [
        {"image_id": image_id, "name": e["name"], "negative": bool(e.get("negative"))}
        for image_id, g in gens
        for e in g.get("embeddings") or []
    ]
    for table, rows in (
        (t.image_gen_terms, terms),
        (t.image_loras, loras),
        (t.image_embeddings, embeddings),
    ):
        if rows:
            conn.execute(sa.insert(table), rows)


# One reprojection at a time, whatever started it. Each run holds this for
# its whole length and reads its settings only while holding it (a chunked
# run re-reads them per chunk, still inside), so runs write in the order they
# read: one that read older rules or keywords can't overwrite a later run's
# rows, and no other run slips in between a run's chunks. Not reentrant: take
# it only at a run's entry points below.
_run_lock = threading.Lock()

# reproject_ids derives this many ids per raw-table read.
_ID_CHUNK = 500


def busy() -> bool:
    """Whether a reprojection is running now. A hint only: callers that must
    not wait take the lock without blocking instead (the ``try_`` paths)."""
    return _run_lock.locked()


def _reproject_where(
    where,
    *,
    force: bool = False,
    task: activity.Task | None = None,
    count_total: bool = True,
) -> int:
    """Recompute ``gen.*`` for every raw row matching ``where``. Returns how
    many were derived (written or already up to date). ``task`` shows the
    progress. Waits for any other run to finish first."""
    with _run_lock:
        return _derive_where(where, force=force, task=task, count_total=count_total)


def _derive_where(
    where, *, force: bool, task: activity.Task | None, count_total: bool
) -> int:
    rulesets = _load_rulesets()
    config = extraction_settings.load_sync()

    with sync_conn() as conn:
        raws = (
            conn.execute(
                sa.select(
                    t.image_gen_raw.c._id,
                    t.image_gen_raw.c.library_id,
                    t.image_gen_raw.c.workflow_sig,
                    t.image_gen_raw.c.raw,
                ).where(where)
            )
        ).fetchall()
    if task is not None and count_total:
        task.add_total(len(raws))

    updated = 0
    batch: list[tuple[str, dict]] = []
    for row in raws:
        if task is not None:
            task.advance()
        raw_doc = {
            "_id": row._id,
            "library_id": row.library_id,
            "workflow_sig": row.workflow_sig,
            **(row.raw or {}),
        }
        ruleset = rulesets.get(row.workflow_sig)
        try:
            g = gen_metadata.derive(raw_doc, ruleset, config)
        except Exception as e:
            # One hostile graph must not leave every later row underived.
            logger.warning("Reprojection skipped %s: %r", row._id, e)
            continue
        if g is None:
            continue
        batch.append((row._id, g))
        if len(batch) >= _BATCH:
            _flush_batch(batch, force=force)
            updated += len(batch)
            batch = []
    if batch:
        _flush_batch(batch, force=force)
        updated += len(batch)
    return updated


def reproject_library(
    library_id: str,
    *,
    workflow_sig: str | None = None,
    task: activity.Task | None = None,
) -> int:
    """Recompute ``gen.*`` for one library's images (optionally scoped to a single
    workflow signature)."""
    where = t.image_gen_raw.c.library_id == library_id
    if workflow_sig is not None:
        where = sa.and_(where, t.image_gen_raw.c.workflow_sig == workflow_sig)
    return _reproject_where(where, task=task)


def reproject_image(image_id: str) -> int:
    """Recompute ``gen.*`` for a single image (watcher single-file ingest).
    Never waits: while another run holds the lock, the image is queued for
    the background (:func:`_defer`), which derives it after that run. Returns
    how many were derived now (0 when deferred)."""
    if not _run_lock.acquire(blocking=False):
        _defer([image_id])
        return 0
    try:
        return _derive_where(
            t.image_gen_raw.c._id == image_id,
            force=False,
            task=None,
            count_total=True,
        )
    finally:
        _run_lock.release()


def reproject_ids(
    image_ids: list[str],
    *,
    task: activity.Task | None = None,
    recheck: Callable[[], Iterable[str]] | None = None,
) -> int:
    """Recompute ``gen.*`` for specific images (after a merge-rule change),
    holding the run lock for the whole list. ``recheck``: see
    :func:`_with_recheck`."""
    with _run_lock:
        return _derive_ids(_with_recheck(image_ids, recheck), task)


def _with_recheck(
    image_ids: list[str], recheck: Callable[[], Iterable[str]] | None
) -> list[str]:
    """``image_ids`` plus what ``recheck`` finds now; the caller holds
    :data:`_run_lock`. A rule change picks its images before it gets the
    lock, while a run that read the old rules may still be writing the old
    names onto others; by the time the lock is ours that run is done, so
    asking again here catches them."""
    if recheck is None:
        return image_ids
    return sorted(set(image_ids).union(recheck()))


def _derive_ids(image_ids: list[str], task: activity.Task | None) -> int:
    """:func:`reproject_ids`' work; the caller holds :data:`_run_lock`.
    Settings are re-read per chunk (:func:`_derive_where`), inside the lock."""
    # The whole run's size up front, so the bar never jumps back a chunk at
    # a time; ids with nothing to derive count as done with their chunk.
    if task is not None:
        task.add_total(len(image_ids))
    updated = 0
    for i in range(0, len(image_ids), _ID_CHUNK):
        chunk = image_ids[i : i + _ID_CHUNK]
        before = task.done if task is not None else 0
        updated += _derive_where(
            t.image_gen_raw.c._id.in_(chunk),
            force=False,
            task=task,
            count_total=False,
        )
        if task is not None:
            task.advance(len(chunk) - (task.done - before))
    return updated


def reproject_all(*, force: bool = False, task: activity.Task | None = None) -> int:
    """Recompute ``gen.*`` for every image with captured generation data.
    ``force`` rewrites rows that come out unchanged too (migrations)."""
    return _reproject_where(sa.true(), force=force, task=task)


def reproject_by_sig(workflow_sig: str, *, task: activity.Task | None = None) -> int:
    """Recompute ``gen.*`` for every image of a signature across all libraries.
    Used when a ruleset is created/edited/deleted (rulesets are sig-global)."""
    return _reproject_where(t.image_gen_raw.c.workflow_sig == workflow_sig, task=task)


def _tracked(work, *args, library_id: str | None = None, **kwargs) -> None:
    """Run a reprojection as visible background work; a failure is logged."""
    try:
        with activity.track("reproject", library_id=library_id) as task:
            work(*args, task=task, **kwargs)
    except Exception:
        logger.exception("Reprojection failed")


def try_reproject_ids_tracked(
    image_ids: list[str], *, recheck: Callable[[], Iterable[str]] | None = None
) -> int | None:
    """:func:`reproject_ids` inline, shown as activity like the background
    runs, but only if no other run holds the lock: ``None`` (nothing done,
    no activity) instead of waiting. A failure propagates to the caller.
    Nothing to derive (after ``recheck``) shows no activity."""
    if not _run_lock.acquire(blocking=False):
        return None
    try:
        image_ids = _with_recheck(image_ids, recheck)
        if not image_ids:
            return 0
        with activity.track("reproject") as task:
            return _derive_ids(image_ids, task)
    finally:
        _run_lock.release()


def _spawn(
    name: str, work, *args, library_id: str | None = None, **kwargs
) -> threading.Thread:
    """Start ``work`` as tracked background reprojection in a daemon thread.
    Runs still execute one at a time (:data:`_run_lock`)."""
    th = threading.Thread(
        target=_tracked,
        args=(work, *args),
        kwargs={"library_id": library_id, **kwargs},
        name=name,
        daemon=True,
    )
    th.start()
    return th


def reproject_library_async(
    library_id: str, *, workflow_sig: str | None = None
) -> threading.Thread:
    """Fire-and-forget reprojection of a library (manual endpoint, post-scan)."""
    return _spawn(
        f"reproject-{library_id}",
        reproject_library,
        library_id,
        workflow_sig=workflow_sig,
        library_id=library_id,
    )


_all_lock = threading.Lock()
_all_running = False
_all_again = False


def reproject_all_async() -> None:
    """Fire-and-forget full reprojection (an extraction-settings save, the
    positive-only switch). Coalesced: requests during a run queue one more
    run after it, not one each, since a full run started later reads every
    setting saved meanwhile."""
    global _all_running, _all_again
    with _all_lock:
        if _all_running:
            _all_again = True
            return
        _all_running = True

    def _run() -> None:
        global _all_running, _all_again
        while True:
            _tracked(reproject_all)
            with _all_lock:
                if not _all_again:
                    _all_running = False
                    return
                _all_again = False

    threading.Thread(target=_run, name="reproject-all", daemon=True).start()


def underived_ids(library_id: str) -> list[str]:
    """Images of a library with captured generation data but no derived
    ``gen``: what a reprojection cut off by a restart left behind (and raws
    extraction can't read, which stay few)."""
    with sync_conn() as conn:
        return list(
            conn.execute(
                sa.select(t.image_gen_raw.c._id)
                .join(t.images, t.images.c._id == t.image_gen_raw.c._id)
                .where(
                    t.image_gen_raw.c.library_id == library_id,
                    # SQL NULL or a JSON null: never derived.
                    sa.func.coalesce(sa.func.json_type(t.images.c.gen), "null")
                    == "null",
                )
            ).scalars()
        )


_deferred_lock = threading.Lock()
_deferred: set[str] = set()
_deferred_running = False


def _defer(image_ids: list[str]) -> None:
    """Queue images for one background drainer that reprojects them after
    whatever run holds the lock now. Ids queued while it runs join its next
    pass, so a burst of watcher events costs one thread, not one each."""
    global _deferred_running
    with _deferred_lock:
        _deferred.update(image_ids)
        if _deferred_running:
            return
        _deferred_running = True

    def _drain() -> None:
        global _deferred_running
        while True:
            with _deferred_lock:
                if not _deferred:
                    _deferred_running = False
                    return
                ids = sorted(_deferred)
                _deferred.clear()
            _tracked(reproject_ids, ids)

    threading.Thread(target=_drain, name="reproject-deferred", daemon=True).start()


def reproject_ids_async(
    image_ids: list[str], *, recheck: Callable[[], Iterable[str]] | None = None
) -> threading.Thread:
    """Fire-and-forget reprojection of specific images (a big rule change,
    resuming a library a restart cut off). ``recheck``: see
    :func:`_with_recheck`."""
    return _spawn("reproject-ids", reproject_ids, image_ids, recheck=recheck)


def reproject_by_sig_async(workflow_sig: str) -> threading.Thread:
    """Fire-and-forget by-sig reprojection (triggered on ruleset save/delete)."""
    return _spawn(f"reproject-sig-{workflow_sig[:8]}", reproject_by_sig, workflow_sig)
