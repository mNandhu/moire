"""Filter facets over the whole library: the LoRA, embedding and size lists
with image counts, for the gallery's filter dropdowns. Each counts the images
of the view asked for (``quarantined=1`` the Quarantined view, else the
default feed's), through the feed's own condition.

Each list reads every image, so it is kept in the tag index's cache
(:func:`tag_index.cached`, the "views" TTL) and invalidated with the other
views over images: a scan's end, a reprojection (which writes the LoRA and
embedding rows and their soft/hard invalidates), a delete, a quarantine or a
rating (``image_tags``), a library removed. The key names the sensitivity
filter's level, since it decides what the default view shows.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from ...database import schema as t
from ...database.db import async_conn
from ..tags import index as tag_index, sensitivity_filter
from . import shapes as image_shapes, visibility as image_visibility


def _key(name: str, library_id: str | None, quarantined: int | None) -> tuple:
    # in_view reads only whether quarantined is 1.
    return (
        f"facets:{name}",
        library_id or None,
        quarantined == 1,
        sensitivity_filter.max_level(),
    )


async def _rows(stmt, library_id: str | None) -> list[Any]:
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        return (await conn.execute(stmt)).fetchall()


async def loras(library_id: str | None, quarantined: int | None) -> list[dict]:
    """Distinct LoRAs with image counts, most used first."""

    async def build() -> list[dict]:
        stmt = (
            sa.select(t.image_loras.c.name, sa.func.count().label("count"))
            .join(t.images, t.images.c._id == t.image_loras.c.image_id)
            .where(image_visibility.in_view(quarantined))
            .group_by(t.image_loras.c.name)
            .order_by(sa.func.count().desc(), t.image_loras.c.name)
        )
        return [
            {"name": r.name, "count": r.count} for r in await _rows(stmt, library_id)
        ]

    return await tag_index.cached(
        "views", _key("loras", library_id, quarantined), build
    )


async def embeddings(library_id: str | None, quarantined: int | None) -> list[dict]:
    """Distinct embeddings with image counts (either prompt side), most used
    first."""

    async def build() -> list[dict]:
        e = t.image_embeddings
        count = sa.func.count(sa.distinct(e.c.image_id))
        stmt = (
            sa.select(e.c.name, count.label("count"))
            .join(t.images, t.images.c._id == e.c.image_id)
            .where(image_visibility.in_view(quarantined))
            .group_by(e.c.name)
            .order_by(count.desc(), e.c.name)
        )
        return [
            {"name": r.name, "count": r.count} for r in await _rows(stmt, library_id)
        ]

    return await tag_index.cached(
        "views", _key("embeddings", library_id, quarantined), build
    )


async def sizes(library_id: str | None, quarantined: int | None) -> list[dict]:
    """Every size preset with how many images have that shape. Presets come in
    order (portrait to landscape), empty ones too."""

    async def build() -> list[dict]:
        stmt = (
            sa.select(
                t.images.c.width, t.images.c.height, sa.func.count().label("count")
            )
            .where(image_visibility.in_view(quarantined))
            .group_by(t.images.c.width, t.images.c.height)
        )
        counts: dict[str, int] = {}
        for r in await _rows(stmt, library_id):
            name = image_shapes.shape_of(r.width, r.height)
            if name:
                counts[name] = counts.get(name, 0) + r.count
        return [
            {
                "shape": s.name,
                "width": s.width,
                "height": s.height,
                "orientation": s.orientation,
                "count": counts.get(s.name, 0),
            }
            for s in image_shapes.SHAPES
        ]

    return await tag_index.cached(
        "views", _key("sizes", library_id, quarantined), build
    )
