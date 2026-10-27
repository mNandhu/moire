"""Character pages: one character's images, look and history, and what the user
set for them.

A character often goes by two tags: the tagger's full name
(``furina_(genshin_impact)``) and the bare name prompts use (``furina``, once
the library backs it, see :mod:`services.tag_categories`). Both are one
character here, keyed by the full name; the bare one is an *alias*.

The page's colour and signature are pure statistics over the character's
tags (:mod:`services.character_look`); this module reads what they count.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import (
    attire,
    character_look,
    face_detect,
    image_tags,
    image_visibility,
    tag_browse,
    tag_categories,
    tag_covers,
    tag_detail,
    tag_index,
)

# The tags :func:`character_look.colour_of` reads, in SQL.
_HAIR_EYES = sa.or_(
    t.image_tags.c.base.like("%\\_hair", escape="\\"),
    t.image_tags.c.base.like("%\\_eyes", escape="\\"),
)


async def signature_counts(
    conn, ids, others: list[str], images: int
) -> tuple[dict[str, int], int]:
    """The tag counts a signature reads, and over how many images: ``ids``
    (a subquery of the character's images) without the ones another
    character (``others``, their tag names) is in, when :func:`character_look.reads_solo`
    says those are enough; all of ``images`` otherwise. So a character drawn
    beside someone else doesn't take on their hair and eyes, as long as there
    are enough pictures of them alone."""
    it = t.image_tags
    shared = (
        sa.select(it.c.image_id).where(it.c.image_id.in_(ids), it.c.base.in_(others))
        if others
        else None
    )
    where = [it.c.image_id.in_(ids), it.c.base != ""]
    counted = images
    if shared is not None:
        sub = shared.subquery()
        crowded = (
            await conn.execute(sa.select(sa.func.count(sa.distinct(sub.c.image_id))))
        ).scalar_one()
        if character_look.reads_solo(images, images - crowded):
            where.append(it.c.image_id.not_in(shared))
            counted = images - crowded
    counts = dict(
        (
            await conn.execute(
                sa.select(it.c.base, sa.func.count(sa.distinct(it.c.image_id)))
                .where(*where)
                .group_by(it.c.base)
            )
        ).fetchall()
    )
    return counts, counted


@dataclass(frozen=True)
class Look:
    """What a character's images say about them (:func:`look_of`). Frozen,
    tuples only: one is memoized and shared by every caller."""

    images: int  # the images they're in
    counted: int  # the ones the signature was read from (signature_counts)
    signature: tuple[tuple[str, int], ...]  # (tag, images), uncapped
    gender: str | None


async def look_of(
    gen: int, key: str, names: list[str], key_of: dict[str, str], rows: list[dict]
) -> Look:
    """The look of the character ``key`` (all its ``names``; ``key_of`` and
    ``rows`` from :func:`named`): how many images they're in, their
    :func:`character_look.signature`, uncapped and unfiltered (the page keeps the
    :data:`character_look.LOOK` facets, a recipe splits identity from attire), and their
    :func:`character_look.gender`. Kept until the next tag write; ``gen`` is the
    generation captured before ``key_of`` and ``rows`` were read. A new
    tagger vocabulary doesn't bump the generation, so the vocabulary it was
    read with is kept beside it."""
    vocab = await tag_categories.load()
    cached = tag_index.read_derived(f"look:{key}")
    if cached is not None and cached[0] is vocab:
        return cached[1]
    ids = tag_detail.image_ids(names)
    it = t.image_tags
    async with async_conn() as conn:
        n = (
            await conn.execute(
                sa.select(sa.func.count(sa.distinct(it.c.image_id))).where(
                    it.c.image_id.in_(ids)
                )
            )
        ).scalar_one()
        total = await tag_detail.visible_count(conn)
        here, counted = await signature_counts(
            conn, ids, [c for c in key_of if c not in names], n
        )
    sig = character_look.signature(
        here,
        counted,
        {r["tag"]: r["count"] for r in rows},
        total,
        skip=set(key_of) | set(names),
        visual=vocab.general,
        # Callers filter first and cap after: near-duplicate images tie many
        # scene tags at the top and would crowd out hair and eyes.
        limit=len(here),
    )
    look = Look(
        n,
        counted,
        tuple((s["tag"], s["count"]) for s in sig),
        character_look.gender(here, counted),
    )
    tag_index.store_derived(f"look:{key}", gen, (vocab, look))
    return look


def groups(characters: list[str], vocab: tag_categories.Vocab) -> dict[str, list[str]]:
    """Each character's names, keyed by the one the page uses: a bare name
    joins its full name when both are in the library. Pure."""
    present = {c.lower(): c for c in characters}
    out: dict[str, list[str]] = {}
    for c in characters:
        cand = vocab.candidates.get(c.lower())
        if cand is not None and cand.full in present:
            out.setdefault(present[cand.full], [present[cand.full]]).append(c)
        else:
            out.setdefault(c, [c])
    return out


async def grouped() -> tuple[dict[str, list[str]], dict[str, str], list[dict]]:
    """Every character's names by page key (:func:`groups`), every character
    name's page key, and the browse rows."""
    rows = await tag_browse.browse("all")
    vocab = await tag_categories.load()
    chars = [r["tag"] for r in rows if r["category"] == "character"]
    found = groups(chars, vocab)
    key_of = {name: key for key, names in found.items() for name in names}
    return found, key_of, rows


async def named(base: str) -> tuple[str, list[str], dict[str, str], list[dict]]:
    """``base``'s page key and all its names; every character name's page key;
    and the browse rows."""
    found, key_of, rows = await grouped()
    key = key_of.get(base, base)
    return key, found.get(key, [base]), key_of, rows


async def names_of(base: str) -> tuple[str, list[str], bool]:
    """``base``'s page key, all its names (itself alone if not a
    character), and whether it is a character."""
    key, names, key_of, _ = await named(base)
    return key, names, base in key_of


# -- Characters made by hand ----------------------------------------------------
#
# A character the library has no image of yet (Fern, before the first one is
# made): a ``characters`` row with kind "character" whose tag no image
# carries. Once one does, it is an ordinary character and the row is just its
# settings.


async def _made(conn, present: set[str], tag: str | None = None) -> list[dict]:
    """Hand-made character rows (one, with ``tag``) whose tag is not among
    ``present`` (the library's tags, compared without case)."""
    c = t.characters
    q = sa.select(c).where(c.c.kind == "character")
    if tag is not None:
        q = q.where(c.c.tag == tag)
    lowered = {p.lower() for p in present}
    rows = (await conn.execute(q)).mappings()
    return [dict(r) for r in rows if r["tag"].lower() not in lowered]


async def is_made(key: str, rows: list[dict]) -> bool:
    """Whether ``key`` is a hand-made character no image carries; ``rows``
    are the library's tag rows (from :func:`named`)."""
    async with async_conn() as conn:
        return bool(await _made(conn, {r["tag"] for r in rows}, key))


async def create(tag: str, patch: dict) -> dict:
    """Make a character by hand, with the settings in ``patch``; returns the
    stored row. Refused when the tag already is a character, or the tagger's
    full name of a bare name the library has as one (``furina``)."""
    if not tag:
        raise CharacterError("tag is required")
    key, names, key_of, rows = await named(tag)
    vocab = await tag_categories.load()
    bare = [b for b, cand in vocab.candidates.items() if cand.full == key.lower()]
    if key in key_of or await is_made(key, rows) or any(b in key_of for b in bare):
        raise Taken("Already a character")
    return await update(tag, {**patch, "kind": "character"})


async def remove_made(tag: str) -> bool:
    """Forget a hand-made character, its recipe, own outfits and cover pin, only
    while no image carries it (a library character is turned off with kind
    instead)."""
    _, _, _, rows = await named(tag)
    if not await is_made(tag, rows):
        return False
    async with async_tx() as conn:
        for table in (
            t.characters,
            t.recipe_edits,
            t.recipe_additions,
            t.recipe_genders,
        ):
            await conn.execute(sa.delete(table).where(table.c.tag == tag))
        await tag_covers.drop_pin(conn, tag)
        # Its own outfits go; shared ones stay, since every character lists them.
        private = (t.outfits.c.character == tag) & t.outfits.c.shared.isnot(True)
        await conn.execute(
            sa.delete(t.outfit_hidden).where(
                (t.outfit_hidden.c.character == tag)
                | t.outfit_hidden.c.outfit_id.in_(
                    sa.select(t.outfits.c._id).where(private)
                )
            )
        )
        await conn.execute(sa.delete(t.outfits).where(private))
        await conn.execute(
            sa.delete(t.outfit_defaults).where(t.outfit_defaults.c.character == tag)
        )
    tag_index.invalidate()
    return True


def _made_entry(row: dict) -> dict:
    return {
        "tag": row["tag"],
        "aliases": [],
        "count": 0,
        "thumb_image_id": None,
        "name": row.get("name"),
        "series": row.get("series"),
        "color": row.get("color"),
        "focus": None,
    }


def made_page(row: dict) -> dict:
    """The page of a character no image has yet: settings only. Pure."""
    return {
        "tag": row["tag"],
        "count": 0,
        "category": "character",
        "first_used": None,
        "last_used": None,
        "sources": {"ai": 0, "prompt": 0, "manual": 0},
        "months": [],
        "loras": [],
        "embeddings": [],
        "workflows": [],
        "related": [],
        "thumb_image_id": None,
        "cover": None,
        "aliases": [],
        "name": row.get("name"),
        "series": row.get("series"),
        "kind": row.get("kind"),
        "color": row.get("color"),
        "focus": None,
        "face": None,
        "aspect": None,
        "palette": [],
        "cover_blurhash": None,
        "signature": [],
        "signature_images": 0,
        "with": [],
        "best": [],
        "scored": {"count": 0, "average": None},
        "ratings": {},
        "made": True,
    }


async def listing() -> list[dict]:
    """Every character, aliases folded in, most images first: what the image
    view shows as the people in a picture. Cached with the tag lists; the
    avatar crops are read fresh, since the face detector fills them in the
    background and can be switched off."""
    rows = tag_index.read_view("characters")
    if rows is None:
        gen = tag_index.current_generation()
        rows = await _listing()
        tag_index.store_view("characters", gen, rows)
    avatars = await _avatars([r["thumb_image_id"] for r in rows])
    # Fresh dicts and lists per call: the cached rows are shared.
    return [
        {
            **r,
            "aliases": list(r["aliases"]),
            "focus": list(r["focus"]) if r["focus"] else r["focus"],
            **avatars.get(r["thumb_image_id"] or "", _NO_AVATAR),
        }
        for r in rows
    ]


async def _listing() -> list[dict]:
    # Only the tags that may be characters: the full Tags list is most of a
    # second on a big library, and the character list is rebuilt after every
    # tag write.
    vocab = await tag_categories.load()
    rows = await tag_browse.character_rows(vocab)
    by = {r["tag"]: r for r in rows}
    found = groups([r["tag"] for r in rows if r["category"] == "character"], vocab)
    key_of = {name: key for key, names in found.items() for name in names}
    images: dict[str, set[str]] = {}
    hair_eyes: list[tuple[str, str]] = []
    async with async_conn() as conn:
        if key_of:
            it = t.image_tags
            ids = tag_detail.image_ids(list(key_of))
            for image_id, base in await conn.execute(
                sa.select(it.c.image_id, it.c.base).where(
                    it.c.image_id.in_(ids), it.c.base.in_(list(key_of))
                )
            ):
                images.setdefault(key_of[base], set()).add(image_id)
            hair_eyes = [
                (r.image_id, r.base)
                for r in await conn.execute(
                    sa.select(it.c.image_id, it.c.base).where(
                        it.c.image_id.in_(ids), _HAIR_EYES
                    )
                )
            ]
        meta = await _meta(conn, list(found))
        covers = await _covers(conn, found, by)
        made = await _made(conn, set(by))
    keys_on: dict[str, set[str]] = {}
    for key, ids in images.items():
        for image_id in ids:
            keys_on.setdefault(image_id, set()).add(key)
    by_image: dict[str, list[tuple[str, str]]] = {}
    for row in hair_eyes:
        by_image.setdefault(row[0], []).append(row)

    def colour(key: str) -> str | None:
        if meta.get(key, {}).get("color"):
            return meta[key]["color"]
        ids = images.get(key, set())
        crowded = {i for i in ids if len(keys_on[i]) > 1}
        rows = [r for i in ids for r in by_image.get(i, [])]
        found_colours = character_look.solo_palette(rows, len(ids), crowded)
        return found_colours[0] if found_colours else None

    out = [
        {
            "tag": key,
            "aliases": names[1:],
            "count": len(images[key]) if key in images else by[key]["count"],
            "thumb_image_id": covers[key],
            "name": meta.get(key, {}).get("name"),
            "series": meta.get(key, {}).get("series"),
            "color": colour(key),
            "focus": _focus(meta.get(key)),
        }
        for key, names in found.items()
    ]
    out += [_made_entry(r) for r in made if r["tag"] not in found]
    out.sort(key=lambda r: (-r["count"], r["tag"]))
    return out


async def _covers(
    conn, found: dict[str, list[str]], by: dict[str, dict]
) -> dict[str, str | None]:
    """Each character's avatar image. A pin may be an image tagged under an
    alias only (``furina``), which the Tags list's cover can't pick, so a
    visible pin carrying any of the character's names wins here."""
    pins = await tag_covers.pins(conn, set(found))
    it = t.image_tags
    valid: set[tuple[str, str]] = set()
    if pins:
        rows = await conn.execute(
            sa.select(it.c.image_id, it.c.base).where(
                it.c.image_id.in_(set(pins.values())),
                sa.exists(
                    sa.select(1).where(
                        t.images.c._id == it.c.image_id,
                        image_visibility.not_quarantined(),
                    )
                ),
            )
        )
        valid = {(r.image_id, r.base) for r in rows}
    return {
        key: pins[key]
        if key in pins and any((pins[key], n) in valid for n in names)
        else by[key]["thumb_image_id"]
        for key, names in found.items()
    }


_NO_AVATAR = {"face": None, "aspect": None}


async def _avatars(image_ids: list[str | None]) -> dict[str, dict]:
    """Each avatar image's shape (width / height) and the face found in it,
    for cropping. Images not yet looked at go to the face detector."""
    ids = [i for i in image_ids if i]
    if not ids:
        return {}
    async with async_conn() as conn:
        shapes = (
            await conn.execute(
                sa.select(t.images.c._id, t.images.c.width, t.images.c.height).where(
                    t.images.c._id.in_(ids)
                )
            )
        ).fetchall()
    # Switched off: no crops, even from faces already found.
    faces = await face_detect.faces_for(ids) if await face_detect.ready() else {}
    await face_detect.queue([i for i in ids if i not in faces])
    return {
        r._id: {
            "face": list(faces[r._id]) if r._id in faces else None,
            "aspect": r.width / r.height if r.width and r.height else None,
        }
        for r in shapes
    }


def _focus(meta: dict | None) -> list[float] | None:
    if not meta or meta.get("focus_x") is None or meta.get("focus_y") is None:
        return None
    return [meta["focus_x"], meta["focus_y"]]


async def _meta(conn, keys: list[str]) -> dict[str, dict]:
    if not keys:
        return {}
    rows = (
        await conn.execute(sa.select(t.characters).where(t.characters.c.tag.in_(keys)))
    ).mappings()
    return {r["tag"]: dict(r) for r in rows}


_BEST = 12
# Average scores show only once this many of the images are scored.
SCORED_ENOUGH = 5


async def page(base: str) -> dict | None:
    """Everything a character page shows (``None`` when no image has the
    tag). ``tag`` is the page's key: a bare name answers with its full one.

    Any other tag gets the same page (the tag page, see ``/tags/character``)
    without the look: only a character's ``palette`` and ``signature`` are
    read, a plain tag's come back empty."""
    gen = tag_index.current_generation()  # before reading what the look reads
    key, names, key_of, rows = await named(base)
    detail = await tag_detail.detail(key, "all", aliases=tuple(names[1:]))
    if detail is None:
        async with async_conn() as conn:
            made = await _made(conn, {r["tag"] for r in rows}, key)
        return made_page(made[0]) if made else None
    core, crowded = await _page_core(key, names, key_of, rows, detail)
    if detail["category"] == "character":
        look = await _page_look(gen, key, names, key_of, rows, detail["count"], crowded)
    else:
        look = {"palette": [], "signature": [], "signature_images": 0}
    return {**core, **look}


async def _page_core(
    key: str, names: list[str], key_of: dict[str, str], rows: list[dict], detail: dict
) -> tuple[dict, set[str]]:
    """Every tag page's part: the panel ``detail``, cover, who else is on the
    images, the best and scored ones, ratings and the LoRAs' scores. Also the
    images another character is on too (for :func:`_page_look`)."""
    ids = tag_detail.image_ids(names)
    im, it = t.images, t.image_tags
    by = {r["tag"]: r for r in rows}
    async with async_conn() as conn:
        cover = (
            await _covers(
                conn, {key: names}, {key: by.get(key, {"thumb_image_id": None})}
            )
        )[key]
        others = (
            await conn.execute(
                sa.select(it.c.image_id, it.c.base).where(
                    it.c.image_id.in_(ids),
                    it.c.base.in_([c for c in key_of if c not in names]),
                )
            )
        ).fetchall()
        best = (
            await conn.execute(
                sa.select(im.c._id, im.c.score)
                .where(im.c._id.in_(ids), im.c.score > 0)
                .order_by(im.c.score.desc(), im.c.mtime.desc())
                .limit(_BEST)
            )
        ).fetchall()
        scored = (
            await conn.execute(
                sa.select(sa.func.count(), sa.func.avg(im.c.score)).where(
                    im.c._id.in_(ids), im.c.score > 0
                )
            )
        ).one()
        lora_scores = (
            await conn.execute(
                sa.select(
                    t.image_loras.c.name,
                    sa.func.count(),
                    sa.func.avg(im.c.score),
                )
                .select_from(
                    t.image_loras.join(im, im.c._id == t.image_loras.c.image_id)
                )
                .where(t.image_loras.c.image_id.in_(ids), im.c.score > 0)
                .group_by(t.image_loras.c.name)
            )
        ).fetchall()
        ratings = (
            await conn.execute(
                sa.select(im.c.rating, sa.func.count())
                .where(im.c._id.in_(ids), im.c.rating.in_(image_tags.RATINGS[1:]))
                .group_by(im.c.rating)
            )
        ).fetchall()
        meta = (await _meta(conn, [key])).get(key, {})
        cover_hash = (
            await conn.execute(sa.select(im.c.blurhash).where(im.c._id == cover))
        ).scalar()

    lora_avg = {name: (cnt, avg) for name, cnt, avg in lora_scores}
    for lora in detail["loras"]:
        cnt, avg = lora_avg.get(lora["name"], (0, None))
        lora["score"] = round(avg, 2) if cnt >= SCORED_ENOUGH else None
    shared: dict[str, set[str]] = {}
    for image_id, other in others:
        shared.setdefault(key_of[other], set()).add(image_id)
    with_others = sorted(
        ({"tag": k, "count": len(v)} for k, v in shared.items()),
        key=lambda r: (-r["count"], r["tag"]),
    )
    crowded = set().union(*shared.values()) if shared else set()
    core = {
        **detail,
        "tag": key,
        "cover": cover,
        "aliases": names[1:],
        "name": meta.get("name"),
        "series": meta.get("series"),
        "kind": meta.get("kind"),
        "color": meta.get("color"),
        "focus": _focus(meta),
        **(await _avatars([cover])).get(cover or "", _NO_AVATAR),
        "cover_blurhash": cover_hash,
        "with": with_others[:12],
        "best": [{"image_id": r._id, "score": r.score} for r in best],
        "scored": {
            "count": scored[0],
            "average": round(scored[1], 2) if scored[0] >= SCORED_ENOUGH else None,
        },
        "ratings": {r: c for r, c in ratings},
    }
    return core, crowded


async def _page_look(
    gen: int,
    key: str,
    names: list[str],
    key_of: dict[str, str],
    rows: list[dict],
    n: int,
    crowded: set[str],
) -> dict:
    """A character page's look: the colours of their hair and eyes, and the
    signature tags of how they're drawn and dressed (:func:`look_of`), over
    their ``n`` images (``crowded``: the ones another character is on too)."""
    look = await look_of(gen, key, names, key_of, rows)
    it = t.image_tags
    async with async_conn() as conn:
        hair_eyes = (
            await conn.execute(
                sa.select(it.c.image_id, it.c.base).where(
                    it.c.image_id.in_(tag_detail.image_ids(names)), _HAIR_EYES
                )
            )
        ).fetchall()
    return {
        "palette": character_look.solo_palette(
            [tuple(r) for r in hair_eyes], n, crowded
        ),
        # Their look: how they're drawn and dressed. Scene, framing, pose
        # and expression shared by a few images from one set aren't it; a
        # tag the groups don't place (`cat_girl`, `tail`) stays.
        "signature": [
            {"tag": tag, "count": count}
            for tag, count in look.signature
            if attire.facet_of(tag) in character_look.LOOK
        ][:30],
        # The images the signature was read from: few means it's a guess.
        "signature_images": look.counted,
    }


FIELDS = ("name", "series", "kind", "color", "focus_x", "focus_y")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class CharacterError(ValueError):
    """An invalid character setting (HTTP 422)."""


class Taken(CharacterError):
    """Making a character that already is one (HTTP 409)."""


def clean(patch: dict) -> dict:
    """Validate a settings patch; empty strings clear a field. Pure."""
    out: dict = {}
    for field, value in patch.items():
        if field not in FIELDS:
            raise CharacterError(f"unknown field {field!r}")
        if isinstance(value, str):
            value = value.strip() or None
        if value is None:
            out[field] = None
        elif field in ("name", "series"):
            if not isinstance(value, str) or len(value) > 120:
                raise CharacterError(f"{field} must be text up to 120 characters")
            out[field] = value
        elif field == "kind":
            if value not in ("character", "general"):
                raise CharacterError("kind must be 'character' or 'general'")
            out[field] = value
        elif field == "color":
            if not isinstance(value, str) or not _HEX.match(value):
                raise CharacterError("color must be #rrggbb")
            out[field] = value.lower()
        else:
            if not isinstance(value, (int, float)) or not 0 <= value <= 1:
                raise CharacterError(f"{field} must be between 0 and 1")
            out[field] = float(value)
    return out


async def update(tag: str, patch: dict) -> dict:
    """Store what the user set for a character, under the name its page uses
    whichever name it was given; returns the stored row."""
    values = clean(patch)
    key, *_ = await names_of(tag_covers.pin_key(tag))
    async with async_tx() as conn:
        if values:
            stmt = sqlite_insert(t.characters).values(
                tag=key, updated_at=time.time(), **values
            )
            await conn.execute(
                stmt.on_conflict_do_update(
                    index_elements=[t.characters.c.tag],
                    set_={**values, "updated_at": stmt.excluded.updated_at},
                )
            )
        row = (await _meta(conn, [key])).get(key, {"tag": key})
    # Every field shows in the cached character list; `kind` also moves the
    # tag between the character and general lists.
    if values:
        tag_index.invalidate()
    return row
