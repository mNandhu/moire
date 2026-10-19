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

import threading

import sqlalchemy as sa

from ..database.db import sync_conn, sync_tx
from ..database import schema as t
from . import gen_metadata
from . import image_tags
from . import tag_index
from .image_tags import to_prompt
from .tag_names import apply_aliases

_BATCH = 200


def _load_rulesets() -> dict[str, dict]:
    """All user rulesets keyed by workflow signature."""
    with sync_conn() as conn:
        rows = (
            conn.execute(sa.select(t.gen_rulesets.c.sig, t.gen_rulesets.c.doc))
        ).fetchall()
    return {r.sig: (r.doc or {}) for r in rows}


def _load_aliases() -> dict[str, str]:
    """The prompt-tag merge rules (``from -> to``), see services/tag_rename.py."""
    with sync_conn() as conn:
        rows = conn.execute(
            sa.select(t.tag_aliases.c.from_name, t.tag_aliases.c.to_name)
        ).fetchall()
    return {r.from_name: r.to_name for r in rows}


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


def _flush_batch(batch: list[tuple[str, dict]]) -> None:
    """Persist one batch of ``(image_id, gen)`` results in a single small tx."""
    with sync_tx() as conn:
        for image_id, g in batch:
            conn.execute(
                sa.update(t.images)
                .where(t.images.c._id == image_id)
                .values(
                    gen=g,
                    gen_model=g.get("model"),
                    gen_workflow_sig=g.get("workflow_sig"),
                    gen_group_id=g.get("group_id"),
                    gen_prompt=g.get("prompt"),
                )
            )
            # Rebuild the derived prompt-term rows for this image.
            conn.execute(
                sa.delete(t.image_gen_terms).where(
                    t.image_gen_terms.c.image_id == image_id
                )
            )
            terms = list(dict.fromkeys(g.get("prompt_terms") or []))
            if terms:
                conn.execute(
                    sa.insert(t.image_gen_terms),
                    [{"image_id": image_id, "term": term} for term in terms],
                )
            # Rebuild the derived lora rows (LoRA filter + counts).
            conn.execute(
                sa.delete(t.image_loras).where(t.image_loras.c.image_id == image_id)
            )
            loras = g.get("loras") or []
            if loras:
                conn.execute(
                    sa.insert(t.image_loras),
                    [
                        {
                            "image_id": image_id,
                            "name": lo["name"],
                            "strength": lo.get("strength"),
                        }
                        for lo in loras
                    ],
                )
            # Mirror the extracted terms into prompt: tags (preserving AI + manual).
            prompt_tags = [to_prompt(term) for term in (g.get("prompt_terms") or [])]
            image_tags.replace_prompt_sync(conn, image_id, prompt_tags)
    # This batch owns its transaction, so it owns the post-commit invalidation of
    # the derived tag aggregation, once per batch, not once per image.
    tag_index.invalidate()


def _reproject_where(where) -> int:
    """Recompute ``gen.*`` for every raw row matching ``where``. Returns updated."""
    rulesets = _load_rulesets()
    positive_only = _prompt_positive_only()
    aliases = _load_aliases()

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

    updated = 0
    batch: list[tuple[str, dict]] = []
    for row in raws:
        raw_doc = {
            "_id": row._id,
            "library_id": row.library_id,
            "workflow_sig": row.workflow_sig,
            **(row.raw or {}),
        }
        ruleset = rulesets.get(row.workflow_sig)
        g = gen_metadata.extract(raw_doc, ruleset, prompt_positive_only=positive_only)
        if g is None:
            continue
        # Merge rules rewrite the extracted terms before they become search
        # terms and prompt: tags, so a merged tag never comes back on re-run.
        g["prompt_terms"] = apply_aliases(g.get("prompt_terms") or [], aliases)
        batch.append((row._id, g))
        if len(batch) >= _BATCH:
            _flush_batch(batch)
            updated += len(batch)
            batch = []
    if batch:
        _flush_batch(batch)
        updated += len(batch)
    return updated


def reproject_library(library_id: str, *, workflow_sig: str | None = None) -> int:
    """Recompute ``gen.*`` for one library's images (optionally scoped to a single
    workflow signature)."""
    where = t.image_gen_raw.c.library_id == library_id
    if workflow_sig is not None:
        where = sa.and_(where, t.image_gen_raw.c.workflow_sig == workflow_sig)
    return _reproject_where(where)


def reproject_image(image_id: str) -> int:
    """Recompute ``gen.*`` for a single image (watcher single-file ingest)."""
    return _reproject_where(t.image_gen_raw.c._id == image_id)


def reproject_ids(image_ids: list[str]) -> int:
    """Recompute ``gen.*`` for specific images (after a merge-rule change)."""
    updated = 0
    for i in range(0, len(image_ids), 500):
        chunk = image_ids[i : i + 500]
        updated += _reproject_where(t.image_gen_raw.c._id.in_(chunk))
    return updated


def reproject_all() -> int:
    """Recompute ``gen.*`` for every image with captured generation data."""
    return _reproject_where(sa.true())


def reproject_by_sig(workflow_sig: str) -> int:
    """Recompute ``gen.*`` for every image of a signature across all libraries.
    Used when a ruleset is created/edited/deleted (rulesets are sig-global)."""
    return _reproject_where(t.image_gen_raw.c.workflow_sig == workflow_sig)


def reproject_library_async(
    library_id: str, *, workflow_sig: str | None = None
) -> None:
    """Fire-and-forget reprojection in a daemon thread (manual endpoint)."""
    th = threading.Thread(
        target=reproject_library,
        args=(library_id,),
        kwargs={"workflow_sig": workflow_sig},
        name=f"reproject-{library_id}",
        daemon=True,
    )
    th.start()


def reproject_by_sig_async(workflow_sig: str) -> None:
    """Fire-and-forget by-sig reprojection (triggered on ruleset save/delete)."""
    th = threading.Thread(
        target=reproject_by_sig,
        args=(workflow_sig,),
        name=f"reproject-sig-{workflow_sig[:8]}",
        daemon=True,
    )
    th.start()
