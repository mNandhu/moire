"""Character pages: one character's images, look and history, and what the user
set for them.

A character often goes by two tags: the tagger's full name
(``furina_(genshin_impact)``) and the bare name prompts use (``furina``, once
the library backs it, see :mod:`services.tag_categories`). Both are one
character here, keyed by the full name; the bare one is an *alias*.

The page's colour comes from the character's own hair and eye tags, never from
the pixels: clothing and scenery change from image to image, hair and eyes
don't. Each colour counts by the share of the character's images that carry
it; white, silver, grey and black only count when no real colour does.
"""

from __future__ import annotations

import math
import re
import time

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import attire, face_detect, image_tags, tag_categories, tag_index

# Colour words in hair / eye tags, as (hue, saturation %, lightness %).
COLOURS: dict[str, tuple[int, int, int]] = {
    "red": (355, 70, 52),
    "dark_red": (355, 60, 38),
    "crimson": (350, 70, 45),
    "orange": (25, 80, 55),
    "yellow": (48, 85, 55),
    "blonde": (44, 75, 60),
    "light_brown": (28, 45, 50),
    "brown": (25, 45, 38),
    "green": (130, 50, 45),
    "light_green": (110, 50, 60),
    "dark_green": (140, 45, 30),
    "aqua": (178, 60, 50),
    "teal": (180, 55, 38),
    "light_blue": (200, 70, 65),
    "blue": (215, 70, 55),
    "dark_blue": (222, 60, 35),
    "purple": (275, 50, 55),
    "light_purple": (275, 55, 70),
    "dark_purple": (275, 45, 35),
    "violet": (270, 60, 60),
    "pink": (335, 70, 70),
    "light_pink": (340, 70, 80),
    "hot_pink": (330, 85, 60),
    "magenta": (310, 70, 50),
    "gold": (45, 80, 50),
    "amber": (38, 85, 50),
}
NEUTRALS = frozenset(
    {"white", "silver", "grey", "gray", "black", "light_grey", "dark_grey"}
)
# Brown is a real colour but a dull one: it gives way to any other.
_WEAK = {"brown": 0.5, "light_brown": 0.5}
# A colour leads only when this share of the character's images carry it.
MIN_SHARE = 0.25
_PART = re.compile(r"^(.+)_(hair|eyes)$")
# The tags :func:`colour_of` reads, in SQL.
_HAIR_EYES = sa.or_(
    t.image_tags.c.base.like("%\\_hair", escape="\\"),
    t.image_tags.c.base.like("%\\_eyes", escape="\\"),
)


def colour_of(base: str) -> str | None:
    """The colour word in a hair / eye tag (``large_innocent_green_eyes`` is
    green, ``light_blue_hair`` light blue), else ``None``. Neutral words come
    back too; the caller weighs them."""
    m = _PART.match(base.lower())
    if not m:
        return None
    words = m.group(1).split("_")
    for n in (2, 1):
        word = "_".join(words[-n:])
        if len(words) >= n and (word in COLOURS or word in NEUTRALS):
            return word
    return None


def palette(rows: list[tuple[str, str]], images: int) -> list[str]:
    """Up to three colours (``hsl(...)``) for a character, strongest first, from
    ``(image_id, base)`` rows of their hair / eye tags over ``images``
    images. Empty when no real colour is common enough. Pure."""
    if images <= 0:
        return []
    carried: dict[str, set[str]] = {}
    for image_id, base in rows:
        word = colour_of(base)
        if word in COLOURS:
            carried.setdefault(word, set()).add(image_id)
    weight = {
        word: len(ids) / images * _WEAK.get(word, 1.0) for word, ids in carried.items()
    }
    ranked = sorted(
        (w for w in weight if weight[w] >= MIN_SHARE * _WEAK.get(w, 1.0)),
        key=lambda w: -weight[w],
    )
    return [f"hsl({h} {s}% {li}%)" for h, s, li in (COLOURS[w] for w in ranked[:3])]


def solo_palette(
    rows: list[tuple[str, str]], images: int, crowded: set[str]
) -> list[str]:
    """:func:`palette`, but another character's hair and eyes shouldn't colour
    this one: the images they're alone in count, when there are enough of
    them (``crowded`` are the shared ones). Pure."""
    solo = images - len(crowded)
    if solo >= SOLO_ENOUGH:
        return palette([r for r in rows if r[0] not in crowded], solo)
    return palette(rows, images)


# How sure a share must be before a tag joins the signature: the Wilson lower
# bound (z = 1, roughly 68%) of its share must reach this, and the tag must be
# on two images. One image in three is a third, but on three images it could
# easily be chance; on fifty it isn't. See :func:`confident`.
CONFIDENT_SHARE = 0.17
# Hair and eye tags that allow a second colour in their slot.
MULTICOLOUR = {
    "hair": frozenset(
        {
            "multicolored_hair",
            "two-tone_hair",
            "gradient_hair",
            "split-color_hair",
            "streaked_hair",
            "colored_inner_hair",
            "rainbow_hair",
        }
    ),
    "eyes": frozenset({"heterochromia", "multicolored_eyes", "gradient_eyes"}),
}


def confident(n: int, images: int) -> bool:
    """Whether ``n`` of ``images`` is a share the signature can trust: on two
    images at least (one image alone is enough only for a one-image
    character), with a Wilson lower bound (z = 1) of ``n / images`` reaching
    :data:`CONFIDENT_SHARE`. With 2 or 3 images that takes 2 of them, with 4
    or 5 still 2 (half, then 40%); from 6 images on, the third
    :func:`signature` already asks for is enough. Pure."""
    if images <= 0 or n <= 0 or (n < 2 and images > 1):
        return False
    p = n / images
    denom = 1 + 1 / images
    centre = p + 1 / (2 * images)
    margin = math.sqrt(p * (1 - p) / images + 1 / (4 * images * images))
    return (centre - margin) / denom >= CONFIDENT_SHARE


def one_colour_per_slot(found: list[dict]) -> list[dict]:
    """``found`` (most common first) keeping one hair colour and one eye
    colour, the most common of each, or two where a multicolour tag of that
    slot (``multicolored_hair``, ``heterochromia``) is in ``found`` too: a
    character has one hair colour, and a stray ``brown_hair`` on one image is
    the tagger's noise. Other tags pass through. Pure."""
    tags = {r["tag"].lower() for r in found}
    room = {part: 2 if tags & multi else 1 for part, multi in MULTICOLOUR.items()}
    out = []
    for r in found:
        base = r["tag"].lower()
        m = _PART.match(base)
        if m and colour_of(base) is not None:
            part = m.group(2)
            if room[part] <= 0:
                continue
            room[part] -= 1
        out.append(r)
    return out


# Solo images the signature reads instead of all, when they're also at least
# half of all: see :func:`reads_solo`.
SOLO_PLENTY = 10


def reads_solo(images: int, solo: int) -> bool:
    """Whether a signature reads only the ``solo`` images (of ``images``).
    Not just :data:`SOLO_ENOUGH` as the palette asks: a colour wants purity,
    but a signature wants numbers, and a character on 100 images, 97 of them
    with someone else, shouldn't be judged on 3. So: enough solo images, and
    either half of all or :data:`SOLO_PLENTY` of them. Pure."""
    return solo >= SOLO_ENOUGH and (2 * solo >= images or solo >= SOLO_PLENTY)


def signature(
    counts: dict[str, int],
    images: int,
    library: dict[str, int],
    total: int,
    *,
    skip: set[str],
    visual: frozenset[str],
    limit: int = 30,
) -> list[dict]:
    """The tags that make a character look like themselves, from ``counts``
    of their tags over ``images`` images (see :func:`signature_counts`).

    A tag qualifies when, in order:

    1. it is a ``visual`` tag, when there are any (the tagger's general tags:
       no artists, LoRA triggers or quality tags), and not in ``skip`` (other
       characters and their own names);
    2. it is on at least a third of the images, and at least twice as common
       there as across the library;
    3. that share is :func:`confident` for this many images, so with few
       images a one-off tag doesn't count;
    4. it survives :func:`one_colour_per_slot`.

    Most common first. Pure."""
    found = []
    for base, n in counts.items():
        if base in skip or images <= 0 or total <= 0:
            continue
        if visual and base.lower() not in visual:
            continue
        share = n / images
        overall = library.get(base, n) / total
        if share >= 1 / 3 and share >= 2 * overall and confident(n, images):
            found.append({"tag": base, "count": n})
    found.sort(key=lambda r: (-r["count"], r["tag"]))
    return one_colour_per_slot(found)[:limit]


# The facets (attire.FACETS) a character page's look keeps: the body and what
# they wear. Props, scenes, poses, expressions and anything the tag groups
# can't place are what one set of images shares, not the character.
LOOK = frozenset({"look", "outfit"})

GENDERS = {
    kind: (
        f"1{kind}",
        *(f"{n}{kind}s" for n in ("2", "3", "4", "5", "6+")),
        *((f"multiple_{kind}s",) if kind != "other" else ()),
    )
    for kind in ("girl", "boy", "other")
}


def gender(counts: dict[str, int], images: int) -> str | None:
    """``girl``, ``boy`` or ``other`` from the count tags on a character's
    images (:func:`signature_counts`), else ``None``: the kind must be on at
    least half the images and twice as common as the next. A character who
    is always drawn beside someone of the other kind (``1girl`` and ``1boy``
    on every image) stays ``None``. Pure."""
    if images <= 0:
        return None
    score = {k: max(counts.get(t, 0) for t in tags) for k, tags in GENDERS.items()}
    ranked = sorted(score.items(), key=lambda kv: -kv[1])
    (top, n), (_, runner) = ranked[0], ranked[1]
    if n * 2 >= images and n >= 2 * runner:
        return top
    return None


async def signature_counts(
    conn, ids, others: list[str], images: int
) -> tuple[dict[str, int], int]:
    """The tag counts a signature reads, and over how many images: ``ids``
    (a subquery of the character's images) without the ones another
    character (``others``, their tag names) is in, when :func:`reads_solo`
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
        if reads_solo(images, images - crowded):
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


async def _named(base: str) -> tuple[str, list[str], dict[str, str], list[dict]]:
    """``base``'s page key and all its names; every character name's page key;
    and the browse rows."""
    rows = await tag_index.browse("all")
    vocab = await tag_categories.load()
    chars = [r["tag"] for r in rows if r["category"] == "character"]
    found = groups(chars, vocab)
    key_of = {name: key for key, names in found.items() for name in names}
    key = key_of.get(base, base)
    return key, found.get(key, [base]), key_of, rows


async def names_of(base: str) -> tuple[str, list[str], bool]:
    """``base``'s page key, all its names (itself alone if not a
    character), and whether it is a character."""
    key, names, key_of, _ = await _named(base)
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
    are the library's tag rows (from :func:`_named`)."""
    async with async_conn() as conn:
        return bool(await _made(conn, {r["tag"] for r in rows}, key))


async def create(tag: str, patch: dict) -> dict:
    """Make a character by hand, with the settings in ``patch``; returns the
    stored row. Refused when the tag already is a character, or the tagger's
    full name of a bare name the library has as one (``furina``)."""
    if not tag:
        raise CharacterError("tag is required")
    key, names, key_of, rows = await _named(tag)
    vocab = await tag_categories.load()
    bare = [b for b, cand in vocab.candidates.items() if cand.full == key.lower()]
    if key in key_of or await is_made(key, rows) or any(b in key_of for b in bare):
        raise Taken("Already a character")
    return await update(tag, {**patch, "kind": "character"})


async def remove_made(tag: str) -> bool:
    """Forget a hand-made character and its recipe, only while no image
    carries it (a library character is turned off with kind instead)."""
    _, _, _, rows = await _named(tag)
    if not await is_made(tag, rows):
        return False
    async with async_tx() as conn:
        for table in (t.characters, t.recipe_edits, t.recipe_additions):
            await conn.execute(sa.delete(table).where(table.c.tag == tag))
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
    rows = await tag_index.browse("all")
    vocab = await tag_categories.load()
    by = {r["tag"]: r for r in rows}
    found = groups([r["tag"] for r in rows if r["category"] == "character"], vocab)
    key_of = {name: key for key, names in found.items() for name in names}
    images: dict[str, set[str]] = {}
    hair_eyes: list[tuple[str, str]] = []
    async with async_conn() as conn:
        if key_of:
            it = t.image_tags
            ids = tag_index.image_ids(list(key_of))
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
        found_colours = solo_palette(rows, len(ids), crowded)
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
    pins = await tag_index._pins(conn, set(found))
    it = t.image_tags
    valid: set[tuple[str, str]] = set()
    if pins:
        rows = await conn.execute(
            sa.select(it.c.image_id, it.c.base).where(
                it.c.image_id.in_(set(pins.values())),
                sa.exists(
                    sa.select(1).where(
                        t.images.c._id == it.c.image_id, image_tags.not_quarantined()
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
# The colour reads solo images only once there are this many.
SOLO_ENOUGH = 3


async def page(base: str) -> dict | None:
    """Everything a character page shows (``None`` when no image has the
    tag). ``tag`` is the page's key: a bare name answers with its full one."""
    key, names, key_of, rows = await _named(base)
    detail = await tag_index.detail(key, "all", aliases=tuple(names[1:]))
    if detail is None:
        async with async_conn() as conn:
            made = await _made(conn, {r["tag"] for r in rows}, key)
        return made_page(made[0]) if made else None
    n = detail["count"]
    ids = tag_index.image_ids(names)
    im, it = t.images, t.image_tags
    library = {r["tag"]: r["count"] for r in rows}
    vocab = await tag_categories.load()
    by = {r["tag"]: r for r in rows}
    async with async_conn() as conn:
        cover = (
            await _covers(
                conn, {key: names}, {key: by.get(key, {"thumb_image_id": None})}
            )
        )[key]
        total = (
            await conn.execute(
                sa.select(sa.func.count()).where(image_tags.not_quarantined())
            )
        ).scalar_one()
        tags_here, sig_images = await signature_counts(
            conn, ids, [c for c in key_of if c not in names], n
        )
        hair_eyes = (
            await conn.execute(
                sa.select(it.c.image_id, it.c.base).where(
                    it.c.image_id.in_(ids), _HAIR_EYES
                )
            )
        ).fetchall()
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
    return {
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
        "palette": solo_palette([tuple(r) for r in hair_eyes], n, crowded),
        "cover_blurhash": cover_hash,
        # Their look: how they're drawn and dressed. Scene, framing, pose
        # and expression shared by a few images from one set aren't it; a
        # tag the groups don't place (`cat_girl`, `tail`) stays.
        "signature": [
            s
            for s in signature(
                tags_here,
                sig_images,
                library,
                total,
                skip=set(key_of) | set(names),
                visual=vocab.general,
                limit=len(tags_here),
            )
            if attire.facet_of(s["tag"]) in LOOK
        ][:30],
        # The images the signature was read from: few means it's a guess.
        "signature_images": sig_images,
        "with": with_others[:12],
        "best": [{"image_id": r._id, "score": r.score} for r in best],
        "scored": {
            "count": scored[0],
            "average": round(scored[1], 2) if scored[0] >= SCORED_ENOUGH else None,
        },
        "ratings": {r: c for r, c in ratings},
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
    key, *_ = await names_of(tag_index.pin_key(tag))
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
