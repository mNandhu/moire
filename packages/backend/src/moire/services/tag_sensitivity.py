"""Sensitivity levels for tags, and each image's ``tag_level`` derived from them.

A level is a step on Danbooru's rating scale, the one the AI tagger's rating
uses: 0 general, 1 sensitive, 2 questionable, 3 explicit. A tag's level says
how far a typical image carrying it goes; an image's ``tag_level`` is the
highest among its tags (any kind: AI, manual or prompt, read by base name,
case ignored: ``manual:Some_Tag`` is ``some_tag``), or NULL when it has no
tags at all (nothing to go on).

Where levels come from:

- ``data/tag_sensitivity.json``, shipped: the non-general tags, built offline
  with local tooling, keyed by :func:`hash_tag` so the file names no tag.
  An unlisted tag is general.
- the ``tag_levels`` table: this library's own levels, over the shipped ones.
  ``source`` "user" was set by hand, "suggested" was imported and not yet
  checked. Either counts.

``tag_level`` is written with the tags (``image_tags.tag_state_values``), so
every tag writer keeps it current. When the levels themselves change (an edit
here, or a new shipped list after an upgrade) the stored values are
recomputed: for one tag's images on an edit, for every image at startup when
the fingerprint of shipped list + table differs from the one recorded.

Call :func:`load_overrides_sync` before anything writes tags at startup, so
those writes already see this library's levels; :func:`sync_levels` after the
migrations.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Iterable

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn, async_tx, sync_conn
from . import app_settings, tag_index
from .tag_hash import HASH_CHARS, hash_tag  # noqa: F401 (re-exported)
from .tag_kinds import ANY_PREFIX, base_of
from .tag_names import canonical_name

logger = logging.getLogger("moire.tag_sensitivity")

PATH = Path(__file__).resolve().parents[1] / "data" / "tag_sensitivity.json"

LEVELS = ("general", "sensitive", "questionable", "explicit")
LEVEL_OF = {name: i for i, name in enumerate(LEVELS)}
SOURCES = ("user", "suggested")

_ROW = "tag_levels"

_lock = threading.Lock()
_shipped: dict[str, int] | None = None
_shipped_bytes: bytes = b""
_overrides: dict[str, tuple[int, str]] = {}
# One edit at a time: each reads the table and installs it as the map, so two
# overlapping edits could otherwise install an older read last.
_edit_lock = asyncio.Lock()


# --- levels -------------------------------------------------------------------


def _load_shipped() -> dict[str, int]:
    """The shipped levels; empty (every tag general, with a warning) when the
    file is missing or unreadable, so a broken edit can't take the app down."""
    global _shipped, _shipped_bytes
    if _shipped is None:
        try:
            raw = PATH.read_bytes()
            _shipped = {k: int(v) for k, v in json.loads(raw)["levels"].items()}
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            logger.warning("tag sensitivity list unavailable: %s", exc)
            raw, _shipped = b"", {}
        _shipped_bytes = raw
    return _shipped


def shipped() -> dict[str, int]:
    """The shipped levels, ``hash_tag(name) -> level``, non-general only."""
    with _lock:
        return _load_shipped()


def level_of(tag: str) -> int:
    """One tag's level (any kind prefix, case ignored): this library's own,
    else the shipped one, else 0."""
    # Any kind prefix, the search's ``any:`` included.
    name = base_of(tag.removeprefix(ANY_PREFIX)).lower()
    own = _overrides.get(name)
    if own is not None:
        return own[0]
    return shipped().get(hash_tag(name), 0)


def tag_level(tags: Iterable[str]) -> int | None:
    """An image's level from its stored tags: the highest among them by base
    name, 0 when none is listed, None when there are no tags."""
    tags = list(tags)
    if not tags:
        return None
    return max(level_of(tag) for tag in tags)


def level_name(level: int | None) -> str | None:
    return None if level is None else LEVELS[level]


def _set_overrides(rows: Iterable[Any]) -> None:
    global _overrides
    with _lock:
        _overrides = {r.tag: (LEVEL_OF[r.level], r.source) for r in rows}


def _overrides_stmt():
    c = t.tag_levels.c
    return sa.select(c.tag, c.level, c.source).where(c.level.in_(LEVELS))


def load_overrides_sync() -> None:
    """Read this library's levels into the map. Startup, before tags are
    written; edits through :func:`set_level` keep it current after."""
    with sync_conn() as conn:
        _set_overrides(conn.execute(_overrides_stmt()).fetchall())


def overrides() -> dict[str, tuple[str, str]]:
    """This library's levels: ``tag -> (level name, source)``."""
    with _lock:
        return {tag: (LEVELS[lv], src) for tag, (lv, src) in _overrides.items()}


def fingerprint() -> str:
    """What the stored ``tag_level`` values were computed from: the shipped
    file and the table's levels (not their sources)."""
    shipped()  # loads the shipped file
    with _lock:
        body = json.dumps(
            sorted((tag, lv) for tag, (lv, _) in _overrides.items())
        ).encode()
        return hashlib.sha256(_shipped_bytes + b"\0" + body).hexdigest()


def reset_for_tests() -> None:
    global _shipped, _overrides, _edit_lock
    with _lock:
        _shipped = None
        _overrides = {}
    _edit_lock = asyncio.Lock()  # each test runs its own event loop


def ship_for_tests(levels: dict[str, int]) -> None:
    """Stand in for the shipped file: ``name -> level``, hashed as shipped."""
    global _shipped, _shipped_bytes
    with _lock:
        _shipped = {hash_tag(name): level for name, level in levels.items()}
        _shipped_bytes = json.dumps(sorted(_shipped.items())).encode()


# --- recomputing stored levels ------------------------------------------------
#
# The rewrites themselves live in image_tags (the one writer of tag columns),
# imported where used: image_tags imports this module for the level map.


def sync_levels() -> int:
    """Startup, after :func:`load_overrides_sync` and the migrations: when the
    levels changed since the stored values were computed (the shipped list
    or this library's table), recompute them all. Sync (call off the event
    loop). Returns how many images changed."""
    from . import image_tags

    current = fingerprint()
    stored = (app_settings.read_sync(_ROW) or {}).get("fingerprint")
    if stored == current:
        return 0
    started = time.monotonic()
    changed = image_tags.recompute_tag_levels_sync()
    app_settings.write_sync(_ROW, {"fingerprint": current})
    tag_index.invalidate()
    logger.info(
        "tag levels: recomputed, %d images changed in %.1fs",
        changed,
        time.monotonic() - started,
    )
    return changed


async def _stored_bases(name: str) -> list[str]:
    """The stored base names that are ``name`` with case ignored (Python's
    lower, as :func:`tag_level` reads them; SQLite's only folds ASCII)."""
    async with async_conn() as conn:
        bases = (
            await conn.execute(sa.select(t.image_tags.c.base).distinct())
        ).scalars()
        return [b for b in bases if b.lower() == name]


# --- editing this library's levels --------------------------------------------


def canonical_level_tag(tag: str) -> str:
    """The name a level is stored under: the base name, canonical spelling,
    lower case (levels ignore case; manual tags keep the user's)."""
    return canonical_name(base_of(tag.strip())).lower()


async def set_level(tag: str, level: str | None, *, source: str = "user") -> int:
    """Set (``level`` a name from :data:`LEVELS`) or drop (``None``, back to the
    shipped level) this library's level for ``tag``, then recompute the
    images carrying it. A suggestion never replaces a level set by hand.
    Returns how many images changed level."""
    from . import image_tags

    if level is not None and level not in LEVEL_OF:
        raise ValueError(f"unknown level {level!r}")
    if source not in SOURCES:
        raise ValueError(f"unknown source {source!r}")
    name = canonical_level_tag(tag)
    if not name:
        raise ValueError("empty tag")
    c = t.tag_levels.c
    async with _edit_lock:
        async with async_tx() as conn:
            current = (
                await conn.execute(sa.select(c.source).where(c.tag == name))
            ).scalar()
            if source == "suggested" and current == "user":
                return 0
            if level is None:
                await conn.execute(sa.delete(t.tag_levels).where(c.tag == name))
            else:
                await conn.execute(
                    sa.insert(t.tag_levels)
                    .prefix_with("OR REPLACE")
                    .values(
                        tag=name, level=level, source=source, updated_at=time.time()
                    )
                )
            rows = (await conn.execute(_overrides_stmt())).fetchall()
        _set_overrides(rows)
        changed = await image_tags.recompute_tag_levels_for(await _stored_bases(name))
        await app_settings.write(_ROW, {"fingerprint": fingerprint()})
    tag_index.invalidate()
    return changed
