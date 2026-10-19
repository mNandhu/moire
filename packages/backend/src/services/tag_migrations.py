"""One-off tag data migrations, run once each at startup (before the AI worker and
the watchers start) and recorded in the ``app_settings`` row "migrations".

``tag_underscores``: tags used to be stored as spaced names (``blue eyes``;
the tagger turned the model's underscores into spaces, prompt terms kept
their spaces). The canonical spelling is now underscores
(:mod:`services.tag_names`). This rewrites every stored spelling once:

- each image's ``tags`` array (AI, manual and prompt tags), with its flags and
  derived ``image_tags`` rows, through ``image_tags.rewrite_tags_sync``;
- the per-tag names inside the ``ai`` subdoc (``general_tags`` /
  ``character_tags``), which the UI joins to ``tags`` for confidence shading;
- pinned tag thumbnails (``tag_meta``), keeping the newer pin on a collision;
- then a full reprojection, which rebuilds ``gen.prompt_terms``, the
  ``image_gen_terms`` rows and the ``prompt:`` tags from the raw prompts.

Idempotent (canonical spelling is), so an interrupted run is simply redone:
the marker is written only after everything else.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import sync_conn, sync_tx
from ..database import schema as t
from . import image_tags, reproject, tag_index
from .tag_names import canonical_name

logger = logging.getLogger("moire.migrations")

_ROW = "migrations"
_BATCH = 200


def _done() -> dict[str, Any]:
    with sync_conn() as conn:
        doc = conn.execute(
            sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == _ROW)
        ).scalar()
    return dict(doc or {})


def _mark(name: str) -> None:
    doc = {**_done(), name: time.time()}
    with sync_tx() as conn:
        stmt = sqlite_insert(t.app_settings).values(_id=_ROW, doc=doc)
        conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[t.app_settings.c._id], set_={"doc": doc}
            )
        )


def canonical_tag_list(tags: list[str]) -> list[str]:
    """Canonical spellings, order kept, duplicates (two spellings that are now
    one tag) dropped."""
    return list(dict.fromkeys(image_tags.canonical_tag(x) for x in tags))


def canonical_ai_meta(ai: dict | None) -> dict | None:
    """The ``ai`` subdoc with its ``[name, prob]`` entries renamed."""
    if not isinstance(ai, dict):
        return ai
    out = dict(ai)
    for key in ("general_tags", "character_tags"):
        entries = ai.get(key)
        if isinstance(entries, list):
            out[key] = [
                [canonical_name(e[0]), *e[1:]]
                if isinstance(e, (list, tuple)) and e and isinstance(e[0], str)
                else e
                for e in entries
            ]
    return out


def _rewrite_images() -> int:
    changed = 0
    last_id = ""
    while True:
        with sync_tx() as conn:
            rows = conn.execute(
                sa.select(t.images.c._id, t.images.c.tags, t.images.c.ai)
                .where(t.images.c._id > last_id)
                .order_by(t.images.c._id)
                .limit(_BATCH)
            ).fetchall()
            if not rows:
                return changed
            for row in rows:
                tags = row.tags or []
                new_tags = canonical_tag_list(tags)
                new_ai = canonical_ai_meta(row.ai)
                if new_tags == tags and new_ai == row.ai:
                    continue
                extra = {"ai": new_ai} if new_ai != row.ai else None
                image_tags.rewrite_tags_sync(conn, row._id, new_tags, extra)
                changed += 1
            last_id = rows[-1]._id


def _rekey_tag_meta() -> None:
    with sync_tx() as conn:
        rows = conn.execute(sa.select(t.tag_meta)).fetchall()
        best: dict[str, Any] = {}
        for row in rows:
            key = image_tags.canonical_tag(row.tag)
            cur = best.get(key)
            if cur is None or (row.updated_at or 0) > (cur.updated_at or 0):
                best[key] = row
        if all(image_tags.canonical_tag(r.tag) == r.tag for r in rows):
            return
        conn.execute(sa.delete(t.tag_meta))
        if best:
            conn.execute(
                sa.insert(t.tag_meta),
                [
                    {
                        "tag": key,
                        "thumb_image_id": row.thumb_image_id,
                        "updated_at": row.updated_at,
                    }
                    for key, row in best.items()
                ],
            )


def migrate_tag_underscores() -> None:
    started = time.monotonic()
    changed = _rewrite_images()
    _rekey_tag_meta()
    reprojected = reproject.reproject_all()
    tag_index.invalidate()
    logger.info(
        "tag_underscores: rewrote %d images, reprojected %d, in %.1fs",
        changed,
        reprojected,
        time.monotonic() - started,
    )


def reproject_for_parser() -> None:
    """Re-derive prompt tags with the current prompt parser
    (services/prompt_parse.py). Raw prompts are untouched; this only rebuilds
    what is derived from them. Bump the migration name when the parser
    changes what it extracts, so existing images pick the change up."""
    started = time.monotonic()
    reprojected = reproject.reproject_all()
    logger.info(
        "prompt_parser_v2: reprojected %d images in %.1fs",
        reprojected,
        time.monotonic() - started,
    )


# In order. Each runs once; its name is recorded when it finishes.
_MIGRATIONS = (
    ("tag_underscores", migrate_tag_underscores),
    ("prompt_parser_v2", reproject_for_parser),
)


def run_pending() -> None:
    """Run every migration not yet recorded. Sync: call off the event loop."""
    done = _done()
    for name, fn in _MIGRATIONS:
        if name not in done:
            fn()
            _mark(name)
