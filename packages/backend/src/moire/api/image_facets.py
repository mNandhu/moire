"""Filter facets and overview numbers over the whole library: the model,
LoRA, embedding and size lists with image counts, and activity stats.
Mounted inside :mod:`api.images`, ahead of its ``/{image_id}`` catch-all."""

import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa
from fastapi import APIRouter, HTTPException, Query

from ..database import schema as t
from ..database.db import async_conn
from ..services import image_feed, image_shapes, image_visibility

router = APIRouter()


@router.get("/models")
async def list_models(library_id: str | None = Query(default=None)):
    """Distinct extracted checkpoints with image counts, for the model filter
    dropdown. Sorted by frequency."""
    stmt = (
        sa.select(t.images.c.gen_model, sa.func.count().label("count"))
        .where(t.images.c.gen_model.isnot(None), image_visibility.not_quarantined())
        .group_by(t.images.c.gen_model)
        .order_by(sa.func.count().desc())
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [{"model": r.gen_model, "count": r.count} for r in rows]


@router.get("/loras")
async def list_loras(library_id: str | None = Query(default=None)):
    """Distinct loras with image counts, for the LoRA filter dropdown. Sorted
    by frequency."""
    stmt = (
        sa.select(t.image_loras.c.name, sa.func.count().label("count"))
        .join(t.images, t.images.c._id == t.image_loras.c.image_id)
        .where(image_visibility.not_quarantined())
        .group_by(t.image_loras.c.name)
        .order_by(sa.func.count().desc(), t.image_loras.c.name)
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [{"name": r.name, "count": r.count} for r in rows]


@router.get("/embeddings")
async def list_embeddings(library_id: str | None = Query(default=None)):
    """Distinct embeddings with image counts (either prompt side), for the
    embedding filter dropdown. Sorted by frequency."""
    e = t.image_embeddings
    count = sa.func.count(sa.distinct(e.c.image_id))
    stmt = (
        sa.select(e.c.name, count.label("count"))
        .join(t.images, t.images.c._id == e.c.image_id)
        .where(image_visibility.not_quarantined())
        .group_by(e.c.name)
        .order_by(count.desc(), e.c.name)
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [{"name": r.name, "count": r.count} for r in rows]


@router.get("/sizes")
async def list_sizes(library_id: str | None = Query(default=None)):
    """Every size preset with how many images have that shape, for the Size
    filter. Presets come in order (portrait to landscape), empty ones too."""
    stmt = (
        sa.select(t.images.c.width, t.images.c.height, sa.func.count().label("count"))
        .where(image_visibility.not_quarantined())
        .group_by(t.images.c.width, t.images.c.height)
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    counts: dict[str, int] = {}
    for r in rows:
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


# Activity is counted per 15-minute slot, then each slot is placed on a local
# day in Python. Every UTC offset in use is a multiple of 15 minutes, so this
# is exact for any zone, DST changes included, which one fixed offset for the
# whole year was not.
_SLOT = 900


@router.get("/stats")
async def image_stats(
    days: int = Query(default=371, ge=1, le=3660),
    tz: str = Query(default="UTC", max_length=64),
    tz_offset: int | None = Query(default=None, ge=-14 * 60, le=14 * 60),
):
    """Overview numbers: images per local calendar day over the last ``days``
    (by file mtime, the generation-time proxy the feed sorts on), and the
    quarantine backlog. ``tz`` is the viewer's IANA zone ("Asia/Kolkata"), so
    days break at their midnight on each date. A zone this server doesn't know
    falls back to ``tz_offset`` (minutes east of UTC, the viewer's current
    offset): right except across DST, better than no chart. Days with no
    images are omitted."""
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        if tz_offset is None:
            raise HTTPException(status_code=422, detail="unknown time zone")
        zone = timezone(timedelta(minutes=tz_offset))
    # The feed's own sort expression, so the range walks ix_images_recent.
    when = image_feed.SORT_KEY
    slot = sa.cast(when / _SLOT, sa.Integer)
    since = time.time() - days * 86400
    activity = (
        sa.select(slot.label("slot"), sa.func.count().label("count"))
        .where(when >= since)
        .group_by(slot)
    )
    quarantined = sa.select(sa.func.count()).where(t.images.c.quarantined.is_(True))
    async with async_conn() as conn:
        rows = (await conn.execute(activity)).fetchall()
        q = (await conn.execute(quarantined)).scalar_one()
    per_day: dict[str, int] = {}
    for r in rows:
        day = datetime.fromtimestamp(r.slot * _SLOT, zone).date().isoformat()
        per_day[day] = per_day.get(day, 0) + r.count
    return {
        "activity": [{"day": d, "count": n} for d, n in sorted(per_day.items())],
        "quarantined": q,
    }
