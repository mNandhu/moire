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
- pinned tag thumbnails (``tag_meta``), keeping the newer pin on a collision
  (``tag_meta_base`` later keys them by base name, one pin per tag);
- then a full reprojection (shared with any other pending step), which
  rebuilds ``gen.prompt_terms``, the ``image_gen_terms`` rows and the
  ``prompt:`` tags from the raw prompts.

Idempotent (canonical spelling is), so an interrupted run is simply redone:
the marker is written only after everything else.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import sync_tx
from ..database import schema as t
from . import app_settings, image_tags, reproject, tag_covers, tag_index
from .tag_names import canonical_name

logger = logging.getLogger("moire.migrations")

_ROW = "migrations"
_BATCH = 200


def _done() -> dict[str, Any]:
    return dict(app_settings.read_sync(_ROW) or {})


def _mark(name: str) -> None:
    doc = {**_done(), name: time.time()}
    app_settings.write_sync(_ROW, doc)


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


def _rekey_tag_meta(key_of: Callable[[str], str] = image_tags.canonical_tag) -> None:
    """Re-key pinned tag thumbnails by ``key_of``, the newer pin winning when
    two old keys land on one."""
    with sync_tx() as conn:
        tag_covers.rekey_pins_sync(conn, key_of)


def migrate_tag_underscores() -> None:
    started = time.monotonic()
    changed = _rewrite_images()
    _rekey_tag_meta()
    logger.info(
        "tag_underscores: rewrote %d images in %.1fs",
        changed,
        time.monotonic() - started,
    )


# In order: (name, data step or None, needs a full reprojection after). Each
# runs once; names are recorded only after the run's reprojection, so an
# interrupted run is redone. A prompt-parser change that alters what is
# extracted is a new reprojection-only entry (raw prompts are untouched; only
# what is derived from them is rebuilt), and however many are pending, one
# reprojection covers them all.
def migrate_tag_meta_base() -> None:
    """A pinned thumbnail belongs to a tag, not to one of its sources: the Tags
    page lists ``blue_eyes`` once whether the AI or a prompt found it."""
    _rekey_tag_meta(lambda tag: image_tags.base_of(image_tags.canonical_tag(tag)))


def migrate_image_faces_mtime() -> None:
    """``image_faces`` gained its ``mtime`` stamp. It is a cache the face
    worker refills, so the old table is replaced, not altered."""
    with sync_tx() as conn:
        t.image_faces.drop(conn, checkfirst=True)
        t.image_faces.create(conn)


def migrate_tag_rules() -> None:
    """Merge rules (``tag_aliases``, one ``to_name``) became ``tag_rules``,
    whose ``to_names`` list also holds splits. The old table (and the
    short-lived ``tag_splits``) is read raw, copied over and dropped. The
    rules themselves are unchanged, so nothing is reprojected."""
    with sync_tx() as conn:
        present = set(sa.inspect(conn).get_table_names())
        rows: list[dict] = []
        if "tag_aliases" in present:
            rows += [
                {"from_name": f, "to_names": [to], "created_at": at}
                for f, to, at in conn.execute(
                    sa.text("SELECT from_name, to_name, created_at FROM tag_aliases")
                )
            ]
        if "tag_splits" in present:
            rows += [
                {"from_name": f, "to_names": json.loads(to), "created_at": at}
                for f, to, at in conn.execute(
                    sa.text("SELECT from_name, to_names, created_at FROM tag_splits")
                )
            ]
        for row in rows:
            conn.execute(
                sqlite_insert(t.tag_rules).values(**row).on_conflict_do_nothing()
            )
        for name in ("tag_aliases", "tag_splits"):
            conn.execute(sa.text(f"DROP TABLE IF EXISTS {name}"))


def migrate_gen_term_weights() -> None:
    """``image_gen_terms`` gained each term's prompt weight. The column is
    added in place (1.0 for every row), so the prompt-term filters keep
    working until the reprojection after it writes ``gen.prompt_weights``
    and the real weights."""
    with sync_tx() as conn:
        cols = {c["name"] for c in sa.inspect(conn).get_columns("image_gen_terms")}
        if "weight" not in cols:
            conn.execute(
                sa.text(
                    "ALTER TABLE image_gen_terms"
                    " ADD COLUMN weight FLOAT NOT NULL DEFAULT 1.0"
                )
            )


_MIGRATIONS = (
    ("tag_underscores", migrate_tag_underscores, True),
    ("prompt_parser_v2", None, True),
    ("prompt_parser_v3", None, True),
    ("prompt_parser_v4", None, True),
    ("gen_loras", None, True),
    ("gen_runtime_prompts", None, True),
    ("gen_prompt_guess", None, True),
    ("gen_guess_paths", None, True),
    ("tag_meta_base", migrate_tag_meta_base, False),
    ("gen_display_eval", None, True),
    # (v2: the dev library already ran a first cut that lowercased names)
    ("gen_embeddings_v2", None, True),
    ("image_faces_mtime", migrate_image_faces_mtime, False),
    ("gen_prompt_loras", None, True),
    ("tag_rules", migrate_tag_rules, False),
    ("gen_term_weights", migrate_gen_term_weights, True),
    # [a|b] is alternation; a weight showing as 1 is 1.
    ("prompt_weights_v2", None, True),
    # ComfyUI escapes only a paren: `\\(` is a stray backslash, not a group.
    ("comfy_escapes", None, True),
)


def run_pending() -> None:
    """Run every migration not yet recorded. Sync: call off the event loop."""
    done = _done()
    pending = [m for m in _MIGRATIONS if m[0] not in done]
    if not pending:
        return
    for _name, step, _reproject in pending:
        if step is not None:
            step()
    if any(needs for _n, _s, needs in pending):
        started = time.monotonic()
        # Forced: a step may have added a derived table that unchanged gen
        # data must still be written into.
        reprojected = reproject.reproject_all(force=True)
        logger.info(
            "migrations %s: reprojected %d images in %.1fs",
            ", ".join(n for n, _s, _r in pending),
            reprojected,
            time.monotonic() - started,
        )
    tag_index.invalidate()
    for name, _step, _reproject in pending:
        _mark(name)
