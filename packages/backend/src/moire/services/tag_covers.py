"""Tag covers: which image stands for a tag.

A tag's cover is its pinned ``tag_meta`` thumbnail when that image is visible
and carries the tag, else the first image of a fixed per-tag shuffle. The
mosaic (:func:`samples_for_tag`) and the Tags page rows
(:mod:`services.tag_browse`) use the same shuffle, so the list shows the cover
the mosaic leads with. Pins are keyed by the tag's base name
(:func:`pin_key`), whichever sources found it. This module is the only
writer of ``tag_meta`` (and of ``tag_focus``, the cover's framing).
"""

from __future__ import annotations

import time
from typing import Any, Callable

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import image_tags, image_visibility, tag_index, tag_kinds

_HASH_MUL, _HASH_MOD = 2654435761, 4294967291
# The seed reads this many leading characters of the name (plus its length).
_SEED_CHARS, _SEED_MOD = 32, 1000003


def _seed(base: str) -> int:
    """A tag's shuffle offset, spread over the whole hash range. Mirrored in
    SQL by :func:`seed_sql`, so the list can pick the same cover the mosaic
    leads with. A small offset (a function of the length and first letter
    only) barely rotated the shuffle, so every tag sharing images led with
    the same one."""
    h = len(base)
    for i in range(_SEED_CHARS):
        h = (h * 31 + (ord(base[i]) if i < len(base) else 0)) % _SEED_MOD
    return h * _HASH_MUL % _HASH_MOD


def seed_sql(base_col):
    """:func:`_seed` in SQL. Run it once per tag, not per tagged image."""
    h = sa.func.length(base_col)
    for i in range(_SEED_CHARS):
        ch = sa.func.coalesce(sa.func.unicode(sa.func.substr(base_col, i + 1, 1)), 0)
        h = (h * 31 + ch) % _SEED_MOD
    return h * _HASH_MUL % _HASH_MOD


def shuffle_rank(rowid, seed):
    """An image's place in a tag's shuffle (lowest first): multiplicative
    hashing of its rowid, offset by the tag's seed. Never negative."""
    return (rowid * _HASH_MUL + seed) % _HASH_MOD


def _shuffle_key(seed):
    return shuffle_rank(sa.literal_column(f"{t.images.name}.rowid"), seed)


# How many matching rows a mosaic reads per image it shows, to find images
# from different batches.
SAMPLE_SPREAD = 8


def _shuffled(tag: str):
    """A fixed shuffle of a tag's images: mosaics look varied across tags (not
    every common tag showing the newest image) yet stay put when an unrelated
    write refreshes them. Multiplicative hashing of the rowid, seeded by the
    tag's name, whichever source is asked for; the first image is the tag's
    cover when nothing is pinned (:func:`tag_browse.browse` picks the same
    one)."""
    return _shuffle_key(_seed(pin_key(tag)))


def pin_key(tag: str) -> str:
    """The ``tag_meta`` key of any spelling of a tag: its base name. A pin
    belongs to the tag, whichever sources found it."""
    tag = tag_kinds.canonical_tag(tag)
    if tag_kinds.is_any(tag):
        return tag[len(tag_kinds.ANY_PREFIX) :]
    return tag_kinds.base_of(tag)


async def pins(conn, bases: set[str]) -> dict[str, str]:
    """The pinned cover image of each of ``bases`` that has one."""
    if not bases:
        return {}
    rows = (
        await conn.execute(
            sa.select(t.tag_meta.c.tag, t.tag_meta.c.thumb_image_id).where(
                t.tag_meta.c.tag.in_(bases)
            )
        )
    ).fetchall()
    return {r.tag: r.thumb_image_id for r in rows if r.thumb_image_id}


async def set_pin(key: str, names: list[str], image_id: str) -> str | None:
    """Pin ``image_id`` (any slash spelling) as the cover kept under ``key``;
    returns the stored id. The image must carry one of ``names`` (a
    character's cover may come from any of its names); None, with nothing
    written, when it doesn't or is unknown."""
    async with async_tx() as conn:
        image_id = await image_tags.resolve_image_id(conn, image_id)
        if image_id is None:
            return None
        carries = (
            await conn.execute(
                sa.select(t.images.c._id).where(
                    t.images.c._id == image_id,
                    sa.exists(
                        sa.select(1).where(
                            t.image_tags.c.image_id == t.images.c._id,
                            t.image_tags.c.base.in_(names),
                        )
                    ),
                )
            )
        ).scalar()
        if not carries:
            return None
        stmt = sqlite_insert(t.tag_meta).values(
            tag=key, thumb_image_id=image_id, updated_at=time.time()
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.tag_meta.c.tag],
            set_={
                "thumb_image_id": stmt.excluded.thumb_image_id,
                "updated_at": stmt.excluded.updated_at,
            },
        )
        await conn.execute(stmt)
    tag_index.invalidate()
    return image_id


async def clear_pin(key: str) -> None:
    """Drop the cover pinned under ``key``: the shuffle picks it again."""
    async with async_tx() as conn:
        await drop_pin(conn, key)
    tag_index.invalidate()


async def drop_pin(conn, key: str) -> None:
    """:func:`clear_pin` on the caller's transaction (a hand-made character
    forgotten with the rest of its rows; the caller invalidates)."""
    await conn.execute(sa.delete(t.tag_meta).where(t.tag_meta.c.tag == key))


def repoint_pins_sync(conn, old_image_id: str, new_image_id: str) -> None:
    """Pins on ``old_image_id`` now name ``new_image_id`` (a nested library's
    copy folded into the image it duplicates), on the caller's sync
    transaction."""
    conn.execute(
        sa.update(t.tag_meta)
        .where(t.tag_meta.c.thumb_image_id == old_image_id)
        .values(thumb_image_id=new_image_id)
    )


def rekey_pins_sync(conn, key_of: Callable[[str], str]) -> None:
    """Re-key every pin by ``key_of`` (a tag-spelling migration), the newer
    pin winning when two old keys land on one, on the caller's sync
    transaction. Writes nothing when every key already is its own."""
    rows = conn.execute(sa.select(t.tag_meta)).fetchall()
    if all(key_of(r.tag) == r.tag for r in rows):
        return
    best: dict[str, Any] = {}
    for row in rows:
        key = key_of(row.tag)
        cur = best.get(key)
        if cur is None or (row.updated_at or 0) > (cur.updated_at or 0):
            best[key] = row
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


async def move(conn, old: str, new: str) -> None:
    """Carry the cover framing and pin kept under ``old`` over to ``new``, on
    the caller's transaction (a rename or merge; the caller invalidates).
    The target keeps its own: then ``old``'s are dropped. The framing moves
    pinned or not, since it is keyed to its image and only applies there."""
    if (
        await conn.execute(sa.select(t.tag_focus.c.tag).where(t.tag_focus.c.tag == new))
    ).scalar() is None:
        await conn.execute(
            sa.update(t.tag_focus).where(t.tag_focus.c.tag == old).values(tag=new)
        )
    else:
        await conn.execute(sa.delete(t.tag_focus).where(t.tag_focus.c.tag == old))
    pinned = (
        await conn.execute(
            sa.select(t.tag_meta.c.thumb_image_id).where(t.tag_meta.c.tag == old)
        )
    ).scalar()
    if pinned is None:
        return
    target_has = (
        await conn.execute(sa.select(t.tag_meta.c.tag).where(t.tag_meta.c.tag == new))
    ).scalar()
    if target_has is None:
        await conn.execute(
            sa.insert(t.tag_meta).values(
                tag=new, thumb_image_id=pinned, updated_at=time.time()
            )
        )
    await conn.execute(sa.delete(t.tag_meta).where(t.tag_meta.c.tag == old))


async def samples_for_tag(tag: str, per: int) -> list[dict]:
    """Up to ``per`` distinct images for one tag's mosaic card (``tag`` a stored
    id, or ``any:<base>`` for every source). A pinned
    ``tag_meta`` thumbnail leads when present; the rest follow ``_shuffled``,
    one per generation batch while there are enough batches (a batch's images
    look alike), then the batches again. Rows
    carry ``_id``/``width``/``height``/``blurhash``; the route decorates them
    with the thumb URL."""
    cache_key = (tag, per)
    cached = tag_index.read_samples(cache_key)
    if cached is not None:
        return cached

    gen = tag_index.current_generation()

    cols = (
        t.images.c._id,
        t.images.c.gen_group_id,
        t.images.c.thumb_key,
        t.images.c.width,
        t.images.c.height,
        t.images.c.blurhash,
    )
    out: list[dict] = []
    seen: set[str] = set()
    # `any:<base>` is the tag from every source; any other id is that one kind.
    match = (
        t.image_tags.c.base == pin_key(tag)
        if tag_kinds.is_any(tag)
        else t.image_tags.c.tag == tag
    )

    async with async_conn() as conn:
        # A pinned thumbnail (tag_meta) leads the mosaic when present.
        pinned = (
            await conn.execute(
                sa.select(t.tag_meta.c.thumb_image_id).where(
                    t.tag_meta.c.tag == pin_key(tag)
                )
            )
        ).scalar()
        if pinned:
            row = (
                await conn.execute(
                    sa.select(*cols).where(
                        t.images.c._id == pinned,
                        image_visibility.not_quarantined(),
                        sa.exists(
                            sa.select(1).where(
                                t.image_tags.c.image_id == t.images.c._id, match
                            )
                        ),
                    )
                )
            ).first()
            if row is not None:
                seen.add(row._id)
                out.append(dict(row._mapping))
        batches = {out[0]["gen_group_id"]} - {None} if out else set()

        # A fixed per-tag shuffle (`_shuffled`) varies images across tags and
        # keeps each mosaic put across refreshes. Full scan + sort of the
        # matching rows, but the result is cached (TTL) and per-tag match sets
        # are small. Over-fetch to backfill any collision with the pinned image.
        # Quarantined images never show, pinned or not.
        remaining = per - len(out)
        if remaining > 0:
            rows = (
                await conn.execute(
                    # EXISTS, not a join: an `any:` match has a row per
                    # source, and one image twice would leave the mosaic short.
                    sa.select(*cols)
                    .where(
                        image_visibility.not_quarantined(),
                        sa.exists(
                            sa.select(1).where(
                                t.image_tags.c.image_id == t.images.c._id, match
                            )
                        ),
                    )
                    .order_by(_shuffled(tag))
                    # Room to skip a batch's other images.
                    .limit((remaining + 1) * SAMPLE_SPREAD)
                )
            ).fetchall()
            fresh = [r for r in rows if r._id not in seen]
            again = []
            for row in fresh:
                group = row.gen_group_id
                if group is not None and group in batches:
                    again.append(row)
                    continue
                if group is not None:
                    batches.add(group)
                out.append(dict(row._mapping))
                if len(out) >= per:
                    break
            for row in again[: max(0, per - len(out))]:
                out.append(dict(row._mapping))

    samples = [
        {
            "_id": d["_id"],
            "width": d.get("width"),
            "height": d.get("height"),
            "blurhash": d.get("blurhash"),
        }
        for d in out
    ]
    tag_index.store_samples(cache_key, gen, samples)
    return samples


async def cover_of(base: str) -> str | None:
    """A tag's cover: what its mosaic leads with (the pin when it is visible
    and carries the tag, else the first of the shuffle). ``None`` when no
    visible image carries ``base``."""
    lead = await samples_for_tag(f"{tag_kinds.ANY_PREFIX}{base}", 1)
    return lead[0]["_id"] if lead else None


# --- Cover focus ----------------------------------------------------------------
#
# Where a plain tag's cover is centred: the tag page's counterpart of a
# character's avatar focus, kept in ``tag_focus`` for the one cover image it
# was set on.


class FocusError(ValueError):
    """An invalid focus point (HTTP 422)."""


def clean(x: object, y: object) -> tuple[float, float] | None:
    """A focus point from two 0..1 numbers, or None when both are empty (clear
    it). Pure."""
    if x in (None, "") and y in (None, ""):
        return None
    ok = all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1
        for v in (x, y)
    )
    if not ok:
        raise FocusError("focus_x and focus_y must be numbers between 0 and 1")
    return float(x), float(y)  # type: ignore[arg-type]


async def all_focus() -> dict[str, tuple[str, list[float]]]:
    """Every saved point as ``{tag: (cover image id, [x, y])}``."""
    async with async_conn() as conn:
        rows = (await conn.execute(sa.select(t.tag_focus))).fetchall()
    return {r.tag: (r.image_id, [r.focus_x, r.focus_y]) for r in rows}


def for_cover(
    saved: tuple[str, list[float]] | None, cover: str | None
) -> list[float] | None:
    """The saved point, while ``cover`` is the image it was set on. Pure."""
    return saved[1] if saved and cover and saved[0] == cover else None


async def get_focus(tag: str, cover: str | None) -> list[float] | None:
    return for_cover((await all_focus()).get(tag), cover)


async def put_focus(
    tag: str, point: tuple[float, float] | None, cover: str | None
) -> list[float] | None:
    async with async_tx() as conn:
        if point is None or not cover:
            await conn.execute(sa.delete(t.tag_focus).where(t.tag_focus.c.tag == tag))
        else:
            stmt = sqlite_insert(t.tag_focus).values(
                tag=tag,
                focus_x=point[0],
                focus_y=point[1],
                image_id=cover,
                updated_at=time.time(),
            )
            await conn.execute(
                stmt.on_conflict_do_update(
                    index_elements=[t.tag_focus.c.tag],
                    set_={
                        "focus_x": stmt.excluded.focus_x,
                        "focus_y": stmt.excluded.focus_y,
                        "image_id": stmt.excluded.image_id,
                        "updated_at": stmt.excluded.updated_at,
                    },
                )
            )
    # No tag_index.invalidate(): the browse list reads focus live.
    return list(point) if point and cover else None


async def aspect_of(image_id: str | None) -> float | None:
    """An image's width / height, for sizing the picker."""
    if not image_id:
        return None
    async with async_conn() as conn:
        r = (
            await conn.execute(
                sa.select(t.images.c.width, t.images.c.height).where(
                    t.images.c._id == image_id
                )
            )
        ).first()
    return r.width / r.height if r and r.width and r.height else None
