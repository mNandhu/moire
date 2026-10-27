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

import re
import time
import uuid
from typing import Any, Iterable

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import attire, recipes, tag_categories, tag_detail
from .image_tags import find_image
from .outfit_wear import WearRule, wears, wears_most
from .tag_names import canonical_name

MAX_TAGS = 40
DEFAULT_ID = "default"
# Never an outfit's cover: an image of nobody wearing anything.
UNDRESSED = ("nude", "completely_nude")


class OutfitError(ValueError):
    pass


_SOURCE = re.compile(r"^(?:manual|prompt|any):")


def clean_tags(tags: Iterable[str]) -> list[str]:
    """Outfit tags as stored and sent: bare canonical names (a pasted
    ``manual:`` / ``prompt:`` prefix dropped), each once, at most
    ``MAX_TAGS``. Pure."""
    out = dict.fromkeys(
        canonical_name(_SOURCE.sub("", x.strip()))
        for x in tags
        if isinstance(x, str) and _SOURCE.sub("", x.strip()).strip()
    )
    return list(out)[:MAX_TAGS]


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
        if len(tags) > MAX_TAGS:
            raise OutfitError(f"an outfit takes 1 to {MAX_TAGS} tags")
        tags = clean_tags(tags)
        if not tags:
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


def rule_of(o: dict[str, Any]) -> WearRule:
    """An outfit view's wear rule: the tags the tagger can check (all of them
    when it can check none) and how many an image must carry. Pure."""
    seen = [x["tag"] for x in o["tags"] if x["checkable"]] or [
        x["tag"] for x in o["tags"]
    ]
    return WearRule(tuple(seen), wears_most(len(seen)), o.get("image_id"))


async def wear_rule(outfit_id: str) -> WearRule | None:
    """The gallery filter's view of an outfit (:func:`rule_of`). ``outfit_id``
    is a saved id or ``default:<character>``. None when it is unknown."""
    if outfit_id.startswith(f"{DEFAULT_ID}:"):
        o = await default(outfit_id.split(":", 1)[1])
    else:
        o = await get(outfit_id)
    return None if o is None else rule_of(o)


WORN_MAX_CHARACTERS = 10


async def worn(image_id: str, characters: list[str]) -> list[dict[str, Any]] | None:
    """The outfits ``image_id`` wears, for the characters in it: each one's
    Default (with tags), own outfits and the shared ones it doesn't hide,
    each outfit once. Every entry is an outfit view plus ``carried`` /
    ``of`` (its checked tags the image has) and ``thumbnail`` (this image
    is its cover); covers first, then the most carried. None when the image
    is unknown."""
    img = await find_image(image_id)
    if img is None:
        return None
    async with async_conn() as conn:
        bases = {
            r[0]
            for r in await conn.execute(
                sa.select(t.image_tags.c.base).where(
                    t.image_tags.c.image_id == img["_id"]
                )
            )
        }
    keys = await recipes.character_keys(characters[:WORN_MAX_CHARACTERS])
    if not keys:
        return []
    # Every saved outfit any of them has, in one go: their own, and the
    # shared ones at least one of them doesn't hide.
    o = t.outfits
    h = t.outfit_hidden
    async with async_conn() as conn:
        rows = [
            dict(r)
            for r in (
                await conn.execute(
                    sa.select(o).where(
                        sa.or_(o.c.character.in_(keys), o.c.shared.is_(True))
                    )
                )
            ).mappings()
        ]
        hidden: dict[str, set[str]] = {}
        for oid, ch in await conn.execute(
            sa.select(h.c.outfit_id, h.c.character).where(h.c.character.in_(keys))
        ):
            hidden.setdefault(oid, set()).add(ch)
        images = await _existing(conn, (r["image_id"] for r in rows))
    vocab = await tag_categories.load()
    saved = [
        _view(r, vocab.general, images, {})
        for r in rows
        if r["character"] in keys or not set(keys) <= hidden.get(r["_id"], set())
    ]
    defaults = [d for d in [await default(k) for k in keys] if d and d["tags"]]
    found: dict[str, dict[str, Any]] = {}
    for view in [*defaults, *saved]:
        is_default = view["_id"] == DEFAULT_ID
        oid = f"{DEFAULT_ID}:{view['character']}" if is_default else view["_id"]
        rule = rule_of(view)
        if oid in found or not wears(rule, img["_id"], bases):
            continue
        found[oid] = {
            **view,
            "carried": len(set(rule.tags) & bases),
            "of": len(rule.tags),
            "thumbnail": view["image_id"] == img["_id"],
        }
    return sorted(
        found.values(),
        key=lambda o: (
            not o["thumbnail"],
            -(o["carried"] / o["of"] if o["of"] else 0),
            o["name"].lower(),
        ),
    )


async def _key(character: str) -> str | None:
    """The page key for any of a character's names; None when it isn't one."""
    found = await recipes.character_key(character)
    return found[0] if found else None


async def _existing(conn, ids: Iterable[str | None]) -> set[str]:
    wanted = [i for i in set(ids) if i]
    if not wanted:
        return set()
    rows = await conn.execute(
        sa.select(t.images.c._id).where(t.images.c._id.in_(wanted))
    )
    return {r[0] for r in rows}


_USAGE = sa.text(
    """
    SELECT json_extract(c.value, '$.outfit.id') AS outfit_id,
           COUNT(DISTINCT b._id) AS batches,
           COUNT(DISTINCT json_extract(c.value, '$.tag')) AS used_by
    FROM generation_batches AS b, json_each(b.inputs, '$.characters') AS c
    WHERE json_extract(c.value, '$.outfit.id') IN :ids
    GROUP BY outfit_id
    """
).bindparams(sa.bindparam("ids", expanding=True))


async def _usage(ids: list[str]) -> dict[str, dict[str, int]]:
    """Outfit id -> batches it was worn in, and by how many characters."""
    if not ids:
        return {}
    async with async_conn() as conn:
        rows = (await conn.execute(_USAGE, {"ids": ids})).fetchall()
    return {r.outfit_id: {"batches": r.batches, "used_by": r.used_by} for r in rows}


def _view(
    row: dict[str, Any],
    general: frozenset[str],
    images: set[str],
    used: dict[str, dict[str, int]],
    hidden: set[str] = frozenset(),  # type: ignore[assignment]
) -> dict[str, Any]:
    u = used.get(row["_id"], {"batches": 0, "used_by": 0})
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
        "used_by": u["used_by"],
        "updated_at": row["updated_at"],
    }


COVER_CHOICES = 24


async def _wearing(
    names: list[str], tags: list[str], limit: int
) -> list[tuple[str, int]]:
    """The character's images wearing any of ``tags``: (image id, how many),
    most first, then best scored, then newest; never one of nobody dressed."""
    if not tags:
        return []
    it, im = t.image_tags, t.images
    wearing = sa.func.count(sa.distinct(it.c.base))
    async with async_conn() as conn:
        rows = await conn.execute(
            sa.select(it.c.image_id, wearing)
            .select_from(it.join(im, im.c._id == it.c.image_id))
            .where(
                it.c.image_id.in_(tag_detail.image_ids(names)),
                it.c.base.in_(tags),
                ~it.c.image_id.in_(tag_detail.image_ids(list(UNDRESSED))),
            )
            .group_by(it.c.image_id)
            .order_by(
                wearing.desc(),
                sa.func.coalesce(sa.func.max(im.c.score), 0).desc(),
                sa.func.max(im.c.mtime).desc(),
            )
            .limit(limit)
        )
        return [(r[0], r[1]) for r in rows]


DEFAULT_NAME = "Default"


def apply_default_edits(
    computed: list[str], edit: dict[str, Any] | None
) -> tuple[list[str], list[dict[str, Any]]]:
    """The Default's tags after the user's edits: the ones it sends, and every
    tag for the editor (``dropped`` / ``added`` marked). Pure."""
    dropped = set((edit or {}).get("dropped") or [])
    added = [x for x in (edit or {}).get("added") or [] if x not in computed]
    chips = [{"tag": x, "dropped": x in dropped, "added": False} for x in computed]
    chips += [{"tag": x, "dropped": False, "added": True} for x in added]
    # As many as any outfit sends.
    return [c["tag"] for c in chips if not c["dropped"]][:MAX_TAGS], chips


async def _default_edit(key: str) -> dict[str, Any] | None:
    d = t.outfit_defaults
    async with async_conn() as conn:
        row = (await conn.execute(sa.select(d).where(d.c.character == key))).first()
    return dict(row._mapping) if row else None


async def default(character: str) -> dict[str, Any] | None:
    """The Default outfit for ``character`` (their usual clothes, with the
    user's edits on top); None when it isn't a character. ``image_id``: the
    cover the user picked (``cover_picked``), else the best-scored image
    wearing most of it. ``chips`` lists every tag for the editor."""
    r = await recipes.wardrobe(character)
    if r is None:
        return None
    edit = await _default_edit(r["tag"])
    tags, chips = apply_default_edits(list(r["outfit"]), edit)
    picked = (edit or {}).get("image_id")
    if picked:
        async with async_conn() as conn:
            picked = picked if picked in await _existing(conn, [picked]) else None
    found = None if picked else await _wearing(r["names"], tags, 1)
    vocab = await tag_categories.load()
    info = {x["tag"]: x for x in tag_info([c["tag"] for c in chips], vocab.general)}
    return {
        "_id": DEFAULT_ID,
        "name": (edit or {}).get("name") or DEFAULT_NAME,
        "character": r["tag"],
        "shared": False,
        "tags": [info[x] for x in tags],
        "chips": [{**info[c["tag"]], **c} for c in chips],
        "edited": bool(
            edit and (edit.get("name") or edit.get("dropped") or edit.get("added"))
        ),
        "image_id": picked or (found[0][0] if found else None),
        "cover_picked": bool(picked),
        "hidden": False,
        "images": r["count"],
    }


def clean_default_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """An edit to a Default from the API: name ("" or null: "Default"),
    dropped / added tag lists, image_id (null: computed cover). Pure."""
    out: dict[str, Any] = {}
    if "name" in patch:
        name = str(patch.get("name") or "").strip()
        if len(name) > 80:
            raise OutfitError("name must be at most 80 characters")
        out["name"] = name if name and name != DEFAULT_NAME else None
    for key in ("dropped", "added"):
        if key in patch:
            v = patch[key]
            if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                raise OutfitError(f"{key} must be a list of tags")
            out[key] = clean_tags(v)
    if "image_id" in patch:
        image = patch["image_id"]
        if image is not None and not isinstance(image, str):
            raise OutfitError("image_id must be an image id or null")
        out["image_id"] = image or None
    return out


async def update_default(
    character: str, patch: dict[str, Any]
) -> dict[str, Any] | None:
    """Edit ``character``'s Default; ``reset`` clears the name and tag edits
    (the cover stays). None when ``character`` isn't one."""
    key = await _key(character)
    if key is None:
        return None
    values = clean_default_patch(patch)
    if patch.get("reset"):
        values.update(name=None, dropped=None, added=None)
    if values:
        values["updated_at"] = time.time()
        d = t.outfit_defaults
        async with async_tx() as conn:
            await conn.execute(
                sqlite_insert(d)
                .values(character=key, **values)
                .on_conflict_do_update(index_elements=["character"], set_=values)
            )
    return await default(key)


async def covers(
    character: str, outfit_id: str | None, tags: list[str] | None = None
) -> list[dict[str, Any]] | None:
    """Images that could be ``outfit_id``'s cover ("default" for the
    character's Default; none: an outfit not saved yet, by its ``tags``):
    the character's images wearing most of its tags, each with the tags it
    lacks (``missing``). None when the character or outfit is unknown."""
    r = await recipes.wardrobe(character)
    if r is None:
        return None
    if not outfit_id:
        tags = clean_tags(tags or [])
    elif outfit_id == DEFAULT_ID:
        tags, _ = apply_default_edits(list(r["outfit"]), await _default_edit(r["tag"]))
    else:
        o = await get(outfit_id)
        # Their own or a shared one: another character's private outfit
        # isn't theirs to wear.
        if o is None or not (o["character"] == r["tag"] or o["shared"]):
            return None
        tags = [x["tag"] for x in o["tags"]]
    found = await _wearing(r["names"], tags, COVER_CHOICES)
    worn: dict[str, set[str]] = {}
    if found:
        it = t.image_tags
        async with async_conn() as conn:
            for image_id, base in await conn.execute(
                sa.select(it.c.image_id, it.c.base).where(
                    it.c.image_id.in_([i for i, _ in found]), it.c.base.in_(tags)
                )
            ):
                worn.setdefault(image_id, set()).add(base)
    return [
        {
            "image_id": i,
            "missing": [x for x in tags if x not in worn.get(i, set())],
            "of": len(tags),
        }
        for i, _ in found
    ]


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
    used = await _usage([r["_id"] for r in rows])
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
    return _view(row, vocab.general, images, await _usage([outfit_id]))


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
            # Hides belong to one sharing: sharing it again starts afresh.
            if values.get("shared") is False:
                await conn.execute(
                    sa.delete(t.outfit_hidden).where(
                        t.outfit_hidden.c.outfit_id == outfit_id
                    )
                )
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
    r = await recipes.wardrobe(character)
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
        canonical_name(_SOURCE.sub("", tg)): i
        for i, tg in enumerate(img.get("tags") or [])
    }
    seen = sorted(
        {b for b in bases if attire.is_attire(b)}, key=lambda b: order.get(b, 1 << 30)
    )
    seen = seen[:MAX_TAGS]
    usual = [x for x in r["outfit"] if x not in seen][: MAX_TAGS - len(seen)]
    vocab = await tag_categories.load()
    info = tag_info([*seen, *usual], vocab.general)
    for i, x in enumerate(info):
        x["source"] = "image" if i < len(seen) else "usual"
    return {"image_id": img["_id"], "character": r["tag"], "tags": info}
