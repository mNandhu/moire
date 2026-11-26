"""Starter outfits: a built-in set of general outfits, so a new user's
Outfit picker isn't empty before they have saved any of their own.

The list ships as package data (``data/starter_outfits.json``), each with a
cover (``data/starter_outfits/<id>.webp``). A starter is worn as it is, by its
id ``starter:<id>``, like a saved outfit; saving one copies it into an
ordinary outfit. Read only: nothing here writes.

For a character, a starter's cover is that character's best image wearing it
(the same pick as their Default's cover), else the shipped one.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import sqlalchemy as sa

from ...database.db import async_conn
from ...database import schema as t
from ..generate import recipes
from ..images import visibility as image_visibility
from ..tags import (
    categories as tag_categories,
    detail as tag_detail,
    index as tag_index,
)
from . import outfits
from .outfit_wear import WearRule

DATA = Path(__file__).resolve().parents[2] / "data"
LIST_PATH = DATA / "starter_outfits.json"
COVERS = DATA / "starter_outfits"
PREFIX = "starter:"
COVER_ROUTE = "/api/v1/generate/outfits/starters"


@dataclass(frozen=True)
class Starter:
    id: str
    name: str
    category: str
    tags: tuple[str, ...]
    # A short hash of the cover's bytes (None when it is missing): the cover
    # URL's version, so a new cover in a release is fetched again.
    cover_version: str | None


def _version(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    except OSError:
        return None


@lru_cache(maxsize=1)
def entries() -> dict[str, Starter]:
    """Every starter by its bare id, in the file's order."""
    try:
        raw = json.loads(LIST_PATH.read_text(encoding="utf-8"))["outfits"]
    except (OSError, ValueError, KeyError):
        return {}
    return {
        o["id"]: Starter(
            id=o["id"],
            name=o["name"],
            category=o["category"],
            tags=tuple(o["tags"]),
            cover_version=_version(COVERS / f"{o['id']}.webp"),
        )
        for o in raw
    }


def is_starter(outfit_id: str) -> bool:
    return outfit_id.startswith(PREFIX)


def find(outfit_id: str) -> Starter | None:
    """The starter an outfit id (``starter:<id>``) or a bare id names."""
    bare = outfit_id[len(PREFIX) :] if is_starter(outfit_id) else outfit_id
    return entries().get(bare)


def cover_path(bare_id: str) -> Path | None:
    """The shipped cover's file, only for a listed starter (an id never
    becomes a path otherwise)."""
    s = entries().get(bare_id)
    if s is None or s.cover_version is None:
        return None
    return COVERS / f"{s.id}.webp"


def cover_url(s: Starter) -> str | None:
    if s.cover_version is None:
        return None
    return f"{COVER_ROUTE}/{s.id}/cover?v={s.cover_version}"


def view(s: Starter, general: frozenset[str]) -> dict[str, Any]:
    """A starter as the picker shows an outfit. ``image_id`` is a library
    image that takes over the cover, set by :func:`listing`."""
    return {
        "_id": f"{PREFIX}{s.id}",
        "name": s.name,
        "category": s.category,
        "character": "",
        "shared": True,
        "starter": True,
        "tags": outfits.tag_info(s.tags, general),
        "image_id": None,
        "hidden": False,
    }


async def wear_rule(outfit_id: str) -> WearRule | None:
    """The gallery filter's view of a starter; None when it isn't one."""
    s = find(outfit_id)
    if s is None:
        return None
    vocab = await tag_categories.load()
    return outfits.rule_of(view(s, vocab.general))


async def _takeovers(names: list[str], rules: dict[str, WearRule]) -> dict[str, str]:
    """Starter id -> the best of the character's images wearing it: the most
    of its tags, then best scored, then newest (as the Default's cover),
    never a hidden image or one of nobody dressed. Cached per character
    (a tag write invalidates it), since the picker asks on every load."""
    return await tag_index.cached(
        "derived", ("starter-takeovers", tuple(names)), lambda: _scan(names, rules)
    )


async def _scan(names: list[str], rules: dict[str, WearRule]) -> dict[str, str]:
    wanted = sorted({tag for r in rules.values() for tag in r.tags})
    if not names or not wanted:
        return {}
    it, im = t.image_tags, t.images
    undressed = await outfits._undressed()
    q = (
        sa.select(it.c.image_id, it.c.base, im.c.score, im.c.mtime)
        .select_from(it.join(im, im.c._id == it.c.image_id))
        .where(
            it.c.image_id.in_(tag_detail.image_ids(names)),
            it.c.base.in_(wanted),
            image_visibility.visible(),
        )
    )
    if undressed:
        q = q.where(~it.c.image_id.in_(tag_detail.image_ids(undressed)))
    worn: dict[str, set[str]] = {}
    rank: dict[str, tuple[float, float]] = {}
    async with async_conn() as conn:
        for image_id, base, score, mtime in await conn.execute(q):
            worn.setdefault(image_id, set()).add(base)
            rank[image_id] = (score or 0.0, mtime or 0.0)
    best: dict[str, str] = {}
    for sid, rule in rules.items():
        choices = [
            (len(set(rule.tags) & bases), *rank[i], i)
            for i, bases in worn.items()
            if len(set(rule.tags) & bases) >= rule.need
        ]
        if choices:
            best[sid] = max(choices)[3]
    return best


async def listing(character: str | None = None) -> list[dict[str, Any]]:
    """Every starter; for ``character``, each cover their best image wearing
    it, where they have one (a character the library doesn't know yet has
    none, so every cover is the shipped one)."""
    vocab = await tag_categories.load()
    views = {s.id: view(s, vocab.general) for s in entries().values()}
    found = await recipes.character_key(character) if character else None
    if found is not None:
        key, names = found[0], found[1]
        rules = {sid: outfits.rule_of(v) for sid, v in views.items()}
        for sid, image_id in (
            await _takeovers(list(dict.fromkeys([key, *names])), rules)
        ).items():
            views[sid]["image_id"] = image_id
    return list(views.values())


def fill_covers(items: list[dict[str, Any]]) -> None:
    """The shipped cover's URL where no library image took over (run after
    ``thumb_version.attach`` set ``thumb_url`` for those that did)."""
    for v in items:
        if not v.get("thumb_url"):
            s = find(v["_id"])
            v["thumb_url"] = cover_url(s) if s else None
