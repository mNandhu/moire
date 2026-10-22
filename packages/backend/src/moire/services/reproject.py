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

import sqlalchemy as sa

from ..database.db import sync_conn, sync_tx
from ..database import schema as t
from . import activity, extraction_settings, gen_metadata
from . import image_tags
from . import tag_index
from .image_tags import to_prompt
from .tag_names import apply_aliases

logger = logging.getLogger("moire.reproject")

_BATCH = 200


def _load_rulesets() -> dict[str, dict]:
    """All user rulesets keyed by workflow signature."""
    with sync_conn() as conn:
        rows = (
            conn.execute(sa.select(t.gen_rulesets.c.sig, t.gen_rulesets.c.doc))
        ).fetchall()
    return {r.sig: (r.doc or {}) for r in rows}


def _load_aliases() -> dict[str, list[str]]:
    """The prompt-tag rules (``from -> [to, ...]``), see services/tag_rename.py."""
    with sync_conn() as conn:
        rows = conn.execute(
            sa.select(t.tag_rules.c.from_name, t.tag_rules.c.to_names)
        ).fetchall()
    return {r.from_name: list(r.to_names) for r in rows}


def _prompt_positive_only() -> bool:
    """Read the ``prompt_positive_only`` AI setting. Defaults to ``True`` so older
    settings that predate the flag keep the on-by-default behaviour."""
    with sync_conn() as conn:
        doc = (
            conn.execute(
                sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == "ai")
            )
        ).scalar()
    return bool((doc or {}).get("prompt_positive_only", True))


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
        {"image_id": image_id, "term": term}
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


def _reproject_where(
    where,
    *,
    force: bool = False,
    task: activity.Task | None = None,
    count_total: bool = True,
) -> int:
    """Recompute ``gen.*`` for every raw row matching ``where``. Returns how
    many were derived (written or already up to date). ``task`` shows the
    progress."""
    rulesets = _load_rulesets()
    positive_only = _prompt_positive_only()
    aliases = _load_aliases()
    keywords = extraction_settings.load_keywords()

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
            g = gen_metadata.extract(
                raw_doc,
                ruleset,
                prompt_positive_only=positive_only,
                guess_keywords=keywords,
            )
        except Exception as e:
            # One hostile graph must not leave every later row underived.
            logger.warning("Reprojection skipped %s: %r", row._id, e)
            continue
        if g is None:
            continue
        # Merge rules rewrite the extracted terms before they become search
        # terms and prompt: tags, so a merged tag never comes back on re-run.
        g["prompt_terms"] = apply_aliases(g.get("prompt_terms") or [], aliases)
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
    """Recompute ``gen.*`` for a single image (watcher single-file ingest)."""
    return _reproject_where(t.image_gen_raw.c._id == image_id)


def reproject_ids(image_ids: list[str], *, task: activity.Task | None = None) -> int:
    """Recompute ``gen.*`` for specific images (after a merge-rule change)."""
    # The whole run's size up front, so the bar never jumps back a chunk at
    # a time; ids with nothing to derive count as done with their chunk.
    if task is not None:
        task.add_total(len(image_ids))
    updated = 0
    for i in range(0, len(image_ids), 500):
        chunk = image_ids[i : i + 500]
        before = task.done if task is not None else 0
        updated += _reproject_where(
            t.image_gen_raw.c._id.in_(chunk), task=task, count_total=False
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


def reproject_library_async(
    library_id: str, *, workflow_sig: str | None = None
) -> None:
    """Fire-and-forget reprojection in a daemon thread (manual endpoint)."""
    th = threading.Thread(
        target=_tracked,
        args=(reproject_library, library_id),
        kwargs={"workflow_sig": workflow_sig, "library_id": library_id},
        name=f"reproject-{library_id}",
        daemon=True,
    )
    th.start()


_all_lock = threading.Lock()
_all_running = False
_all_again = False


def reproject_all_async() -> None:
    """Fire-and-forget full reprojection (an extraction-settings save, the
    positive-only switch). Coalesced: a request during a run queues one more
    run after it, so overlapping runs that read the settings at different
    moments can't leave rows derived with the older ones."""
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


def reproject_ids_async(image_ids: list[str]) -> None:
    threading.Thread(
        target=_tracked,
        args=(reproject_ids, image_ids),
        name="reproject-ids",
        daemon=True,
    ).start()


def reproject_by_sig_async(workflow_sig: str) -> None:
    """Fire-and-forget by-sig reprojection (triggered on ruleset save/delete)."""
    th = threading.Thread(
        target=_tracked,
        args=(reproject_by_sig, workflow_sig),
        name=f"reproject-sig-{workflow_sig[:8]}",
        daemon=True,
    )
    th.start()
