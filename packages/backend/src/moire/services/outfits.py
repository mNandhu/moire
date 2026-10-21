"""Outfits: attire tags a character wears, for the composer's "Wears" picker.

- **Default** is computed: the character's attire signature tags (the
  recipe's ``outfit``), its thumbnail the best-scored image wearing most of
  them. Never stored.
- **Saved** outfits are made from an image in the viewer (the image is the
  thumbnail) for one character; ``shared`` lists one for every character,
  and a character can hide a shared one from its own list.

Tags are canonical names. One the tagger can't produce (not in its general
vocabulary) is kept but marked: nothing can check an image wears it.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Iterable

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import attire, characters, recipes, tag_categories, tag_index
from .image_tags import canonical_tag, find_image

MAX_TAGS = 40
DEFAULT_ID = "default"
# Never an outfit's cover: an image of nobody wearing anything.
UNDRESSED = ("nude", "completely_nude")


class OutfitError(ValueError):
    pass


def clean(patch: dict[str, Any], *, new: bool) -> dict[str, Any]:
    """An outfit from the API: name (1-80 chars), tags (1-40, canonical, each
    once), shared, image_id. The character is checked by the caller. Pure."""
    out: dict[str, Any] = {}
    if "name" in patch or new:
        name = str(patch.get("name") or "").strip()
        if not 1 <= len(name) <= 80:
            raise OutfitError("name must be 1 to 80 characters")
        out["name"] = name
    if "tags" in patch or new:
        tags = patch.get("tags")
        if not isinstance(tags, list) or not all(isinstance(x, str) for x in tags):
            raise OutfitError("tags must be a list of tags")
        tags = list(dict.fromkeys(canonical_tag(x) for x in tags if x.strip()))
        if not 1 <= len(tags) <= MAX_TAGS:
            raise OutfitError(f"an outfit takes 1 to {MAX_TAGS} tags")
        out["tags"] = tags
    if "shared" in patch:
        if not isinstance(patch["shared"], bool):
            raise OutfitError("shared must be true or false")
        out["shared"] = patch["shared"]
    if "image_id" in patch:
        image = patch["image_id"]
        if image is not None and not isinstance(image, str):
            raise OutfitError("image_id must be an image id or null")
        out["image_id"] = image or None
    return out


def tag_info(tags: Iterable[str], general: frozenset[str]) -> list[dict[str, Any]]:
    """Each tag with its attire group (None when unlisted) and whether the
    tagger can check it. Before the tagger's vocabulary is read (empty),
    every tag counts as checkable. Pure."""
    return [
        {
            "tag": tag,
            "group": attire.group_of(tag),
            "checkable": not general or tag in general,
        }
        for tag in tags
    ]


def usage(batch_characters: Iterable[Any]) -> dict[str, dict[str, Any]]:
    """Outfit id -> {batches, characters} over batches' recorded
    ``characters`` lists. Pure."""
    out: dict[str, dict[str, Any]] = {}
    for chars in batch_characters:
        if not isinstance(chars, list):
            continue
        seen: set[str] = set()
        for c in chars:
            o = c.get("outfit") if isinstance(c, dict) else None
            oid = o.get("id") if isinstance(o, dict) else None
            if not isinstance(oid, str) or oid == DEFAULT_ID:
                continue
            u = out.setdefault(oid, {"batches": 0, "characters": set()})
            if oid not in seen:
                u["batches"] += 1
                seen.add(oid)
            u["characters"].add(c.get("tag"))
    return out


async def _key(character: str) -> str | None:
    """The page key for any of a character's names; None when it isn't one."""
    key, _, key_of, rows = await characters._named(character)
    if key not in key_of and not await characters.is_made(key, rows):
        return None
    return key


async def _existing(conn, ids: Iterable[str | None]) -> set[str]:
    wanted = [i for i in set(ids) if i]
    if not wanted:
        return set()
    rows = await conn.execute(
        sa.select(t.images.c._id).where(t.images.c._id.in_(wanted))
    )
    return {r[0] for r in rows}


async def _usage() -> dict[str, dict[str, Any]]:
    b = t.generation_batches
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(sa.func.json_extract(b.c.inputs, "$.characters"))
            )
        ).fetchall()
    return usage(json.loads(r[0]) if isinstance(r[0], str) else r[0] for r in rows)


def _view(
    row: dict[str, Any],
    general: frozenset[str],
    images: set[str],
    used: dict[str, dict[str, Any]],
    hidden: set[str] = frozenset(),  # type: ignore[assignment]
) -> dict[str, Any]:
    u = used.get(row["_id"], {"batches": 0, "characters": set()})
    return {
        "_id": row["_id"],
        "name": row["name"],
        "character": row["character"],
        "shared": bool(row["shared"]),
        "tags": tag_info(row["tags"] or [], general),
        # Gone from the library: no thumbnail.
        "image_id": row["image_id"] if row["image_id"] in images else None,
        "hidden": row["_id"] in hidden,
        "batches": u["batches"],
        "used_by": len(u["characters"]),
        "updated_at": row["updated_at"],
    }


async def default(character: str) -> dict[str, Any] | None:
    """The computed Default outfit for ``character``; None when it isn't a
    character. ``image_id``: the best-scored image wearing most of it."""
    r = await recipes.recipe(character)
    if r is None:
        return None
    tags = list(r["outfit"])
    image_id = None
    if tags:
        _, names, _, _ = await characters._named(r["tag"])
        it, im = t.image_tags, t.images
        wearing = sa.func.count(sa.distinct(it.c.base))
        async with async_conn() as conn:
            image_id = (
                await conn.execute(
                    sa.select(it.c.image_id)
                    .select_from(it.join(im, im.c._id == it.c.image_id))
                    .where(
                        it.c.image_id.in_(tag_index.image_ids(names)),
                        it.c.base.in_(tags),
                        ~it.c.image_id.in_(tag_index.image_ids(list(UNDRESSED))),
                    )
                    .group_by(it.c.image_id)
                    .order_by(
                        wearing.desc(),
                        sa.func.coalesce(sa.func.max(im.c.score), 0).desc(),
                        sa.func.max(im.c.mtime).desc(),
                    )
                    .limit(1)
                )
            ).scalar()
    vocab = await tag_categories.load()
    return {
        "_id": DEFAULT_ID,
        "name": "Default",
        "character": r["tag"],
        "shared": False,
        "tags": tag_info(tags, vocab.general),
        "image_id": image_id,
        "hidden": False,
        "images": r["count"],
    }


async def listing(character: str | None = None) -> list[dict[str, Any]]:
    """Every saved outfit (the Outfits page), or a character's list: its own
    and the shared ones (``hidden`` marks those it hides). Newest first."""
    o = t.outfits
    key = None
    if character is not None:
        key = await _key(character)
        if key is None:
            raise OutfitError("not a character")
    q = sa.select(o).order_by(o.c.updated_at.desc())
    if key is not None:
        q = q.where(sa.or_(o.c.character == key, o.c.shared.is_(True)))
    async with async_conn() as conn:
        rows = [dict(r) for r in (await conn.execute(q)).mappings()]
        images = await _existing(conn, (r["image_id"] for r in rows))
        hidden: set[str] = set()
        if key is not None:
            hidden = {
                r[0]
                for r in await conn.execute(
                    sa.select(t.outfit_hidden.c.outfit_id).where(
                        t.outfit_hidden.c.character == key
                    )
                )
            }
    vocab = await tag_categories.load()
    used = await _usage()
    return [_view(r, vocab.general, images, used, hidden) for r in rows]


async def get(outfit_id: str) -> dict[str, Any] | None:
    o = t.outfits
    async with async_conn() as conn:
        row = (await conn.execute(sa.select(o).where(o.c._id == outfit_id))).first()
        if row is None:
            return None
        row = dict(row._mapping)
        images = await _existing(conn, [row["image_id"]])
    vocab = await tag_categories.load()
    return _view(row, vocab.general, images, await _usage())


async def create(body: dict[str, Any]) -> dict[str, Any]:
    values = clean(body, new=True)
    key = await _key(str(body.get("character") or ""))
    if key is None:
        raise OutfitError("character must be a character")
    now = time.time()
    row = {
        "_id": uuid.uuid4().hex,
        "character": key,
        "shared": False,
        "image_id": None,
        **values,
        "created_at": now,
        "updated_at": now,
    }
    async with async_tx() as conn:
        await conn.execute(sa.insert(t.outfits).values(**row))
    return await get(row["_id"])  # type: ignore[return-value]


async def update(outfit_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    values = clean(patch, new=False)
    if "character" in patch:
        key = await _key(str(patch.get("character") or ""))
        if key is None:
            raise OutfitError("character must be a character")
        values["character"] = key
    o = t.outfits
    async with async_tx() as conn:
        if values:
            values["updated_at"] = time.time()
            res = await conn.execute(
                sa.update(o).where(o.c._id == outfit_id).values(**values)
            )
            if not res.rowcount:
                return None
    return await get(outfit_id)


async def delete(outfit_id: str) -> bool:
    async with async_tx() as conn:
        res = await conn.execute(
            sa.delete(t.outfits).where(t.outfits.c._id == outfit_id)
        )
        await conn.execute(
            sa.delete(t.outfit_hidden).where(t.outfit_hidden.c.outfit_id == outfit_id)
        )
    return bool(res.rowcount)


async def set_hidden(outfit_id: str, character: str, hidden: bool) -> bool:
    """Hide a shared outfit from ``character``'s list (or show it again).
    False when the outfit is gone; an error when it isn't shared."""
    key = await _key(character)
    if key is None:
        raise OutfitError("character must be a character")
    h = t.outfit_hidden
    async with async_tx() as conn:
        shared = (
            await conn.execute(
                sa.select(t.outfits.c.shared).where(t.outfits.c._id == outfit_id)
            )
        ).first()
        if shared is None:
            return False
        if not shared[0]:
            raise OutfitError("only a shared outfit can be hidden")
        if hidden:
            await conn.execute(
                sqlite_insert(h)
                .values(character=key, outfit_id=outfit_id)
                .on_conflict_do_nothing()
            )
        else:
            await conn.execute(
                sa.delete(h).where(h.c.character == key, h.c.outfit_id == outfit_id)
            )
    return True


async def prefill(image_id: str, character: str) -> dict[str, Any] | None:
    """What the save dialog starts with: the image's attire tags (seen by the
    tagger, added by hand or prompted: most generated images have only their
    prompt's tags; ``source`` "image"), then the character's usual ones it
    lacks ("usual"). None when the image or character is unknown."""
    img = await find_image(image_id)
    r = await recipes.recipe(character)
    if img is None or r is None:
        return None
    it = t.image_tags
    async with async_conn() as conn:
        bases = [
            row[0]
            for row in await conn.execute(
                sa.select(it.c.base).where(it.c.image_id == img["_id"])
            )
        ]
    # In the image's own tag order, not the join table's.
    order = {
        canonical_tag(tg.split(":", 1)[-1]): i
        for i, tg in enumerate(img.get("tags") or [])
    }
    seen = sorted(
        {b for b in bases if attire.is_attire(b)}, key=lambda b: order.get(b, 1 << 30)
    )
    usual = [x for x in r["outfit"] if x not in seen]
    vocab = await tag_categories.load()
    info = tag_info([*seen, *usual], vocab.general)
    for i, x in enumerate(info):
        x["source"] = "image" if i < len(seen) else "usual"
    return {"image_id": img["_id"], "character": r["tag"], "tags": info}
