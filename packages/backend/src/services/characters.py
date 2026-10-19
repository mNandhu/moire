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

import re
import time

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import image_tags, tag_categories, tag_index

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
    """The tags that make a character look like themselves: on at least a
    third of their images and at least twice as common there as across the
    library. Only ``visual`` tags count when there are any (the tagger's
    general tags: no artists, LoRA triggers or quality tags); ``skip`` drops
    other characters and their own names. Most common first. Pure."""
    found = []
    for base, n in counts.items():
        if base in skip or images <= 0 or total <= 0:
            continue
        if visual and base.lower() not in visual:
            continue
        share = n / images
        overall = library.get(base, n) / total
        if share >= 1 / 3 and share >= 2 * overall:
            found.append({"tag": base, "count": n})
    found.sort(key=lambda r: (-r["count"], r["tag"]))
    return found[:limit]


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


async def listing() -> list[dict]:
    """Every character, aliases folded in, most images first: what the image
    view shows as the people in a picture."""
    rows = await tag_index.browse("all")
    vocab = await tag_categories.load()
    by = {r["tag"]: r for r in rows}
    found = groups([r["tag"] for r in rows if r["category"] == "character"], vocab)
    merged = {key: names for key, names in found.items() if len(names) > 1}
    counts: dict[str, int] = {}
    async with async_conn() as conn:
        for key, names in merged.items():
            counts[key] = (
                await conn.execute(
                    sa.select(sa.func.count()).where(
                        t.images.c._id.in_(tag_index.image_ids(names))
                    )
                )
            ).scalar_one()
        meta = await _meta(conn, list(found))
    out = [
        {
            "tag": key,
            "aliases": names[1:],
            "count": counts.get(key, by[key]["count"]),
            "thumb_image_id": by[key]["thumb_image_id"],
            "name": meta.get(key, {}).get("name"),
            "focus": _focus(meta.get(key)),
        }
        for key, names in found.items()
    ]
    out.sort(key=lambda r: (-r["count"], r["tag"]))
    return out


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
        return None
    n = detail["count"]
    ids = tag_index.image_ids(names)
    im, it = t.images, t.image_tags
    library = {r["tag"]: r["count"] for r in rows}
    vocab = await tag_categories.load()
    async with async_conn() as conn:
        total = (
            await conn.execute(
                sa.select(sa.func.count()).where(image_tags.not_quarantined())
            )
        ).scalar_one()
        tags_here = dict(
            (
                await conn.execute(
                    sa.select(it.c.base, sa.func.count(sa.distinct(it.c.image_id)))
                    .where(it.c.image_id.in_(ids), it.c.base != "")
                    .group_by(it.c.base)
                )
            ).fetchall()
        )
        hair_eyes = (
            await conn.execute(
                sa.select(it.c.image_id, it.c.base).where(
                    it.c.image_id.in_(ids),
                    sa.or_(
                        it.c.base.like("%\\_hair", escape="\\"),
                        it.c.base.like("%\\_eyes", escape="\\"),
                    ),
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
            await conn.execute(
                sa.select(im.c.blurhash).where(
                    im.c._id == (detail["thumb_image_id"] or _first(rows, key))
                )
            )
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
    # Another character's hair and eyes shouldn't colour this one: use the
    # images they're alone in, when there are enough of them.
    crowded = set().union(*shared.values()) if shared else set()
    solo = n - len(crowded)
    if solo >= SOLO_ENOUGH:
        hair_eyes = [r for r in hair_eyes if r[0] not in crowded]
    return {
        **detail,
        "tag": key,
        "aliases": names[1:],
        "name": meta.get("name"),
        "series": meta.get("series"),
        "kind": meta.get("kind"),
        "color": meta.get("color"),
        "focus": _focus(meta),
        "palette": palette(
            [tuple(r) for r in hair_eyes], solo if solo >= SOLO_ENOUGH else n
        ),
        "cover_blurhash": cover_hash,
        "signature": signature(
            tags_here,
            n,
            library,
            total,
            skip=set(key_of) | set(names),
            visual=vocab.general,
        ),
        "with": with_others[:12],
        "best": [{"image_id": r._id, "score": r.score} for r in best],
        "scored": {
            "count": scored[0],
            "average": round(scored[1], 2) if scored[0] >= SCORED_ENOUGH else None,
        },
        "ratings": {r: c for r, c in ratings},
    }


def _first(rows: list[dict], key: str) -> str | None:
    return next((r["thumb_image_id"] for r in rows if r["tag"] == key), None)


FIELDS = ("name", "series", "kind", "color", "focus_x", "focus_y")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class CharacterError(ValueError):
    """An invalid character setting (HTTP 422)."""


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
    """Store what the user set for a character; returns the stored row."""
    key = tag_index.pin_key(tag)
    values = clean(patch)
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
    if "kind" in values:
        tag_index.invalidate()
    return row
