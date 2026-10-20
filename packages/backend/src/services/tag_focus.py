"""Where a plain tag's cover is centred: the tag page's counterpart of a
character's avatar focus. Cover pins stay in ``tag_meta``; this is only the
framing."""

from __future__ import annotations

import time

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t


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


async def get(tag: str, cover: str | None) -> list[float] | None:
    return for_cover((await all_focus()).get(tag), cover)


async def put(
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
