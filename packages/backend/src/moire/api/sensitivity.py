"""The Global Sensitivity Filter's setting, and what it would hide."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn
from ..services import image_visibility, sensitivity_filter, tag_index, tag_sensitivity

router = APIRouter()


class SensitivityPatch(BaseModel):
    #: general, sensitive or questionable; null (or explicit) turns it off.
    max_level: str | None


async def _counts() -> dict:
    """Images out of quarantine by level, the filter aside: ``unknown`` has
    no level yet (no rating, and no tags that vouch for one), which the
    filter hides until AI tagging gives it one. Every page header asks, so
    it is kept in the tag index's derived cache, which tag writes, ratings,
    quarantine and level edits clear."""
    return await tag_index.cached("derived", "sensitivity-counts", _count)


async def _count() -> dict:
    level = image_visibility.image_level().label("level")
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(level, sa.func.count())
                .select_from(t.images)
                .where(image_visibility.not_quarantined())
                .group_by(level)
            )
        ).fetchall()
    by_level = {name: 0 for name in tag_sensitivity.LEVELS}
    unknown = 0
    for lv, n in rows:
        if lv is None:
            unknown += n
        else:
            by_level[tag_sensitivity.LEVELS[lv]] += n
    return {"unknown": unknown, "by_level": by_level}


@router.get("")
async def get_sensitivity():
    """``max_level``: the highest level shown, null while the filter is off.
    ``counts``: images by level and how many have none yet."""
    return {**sensitivity_filter.state(), "counts": await _counts()}


@router.post("")
async def set_sensitivity(body: SensitivityPatch):
    try:
        state = await sensitivity_filter.set_max_level(body.max_level)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {**state, "counts": await _counts()}


class TagLevelPatch(BaseModel):
    tag: str
    #: general, sensitive, questionable or explicit; null drops this
    #: library's level (back to the shipped one).
    level: str | None


async def _tag_rows() -> list[dict]:
    """This library's tag levels, with how many images carry each tag."""
    own = tag_sensitivity.overrides()
    if not own:
        return []
    base = sa.func.lower(t.image_tags.c.base)
    async with async_conn() as conn:
        counts = dict(
            (
                await conn.execute(
                    sa.select(base, sa.func.count(sa.distinct(t.image_tags.c.image_id)))
                    .where(base.in_(list(own)))
                    .group_by(base)
                )
            ).fetchall()
        )
    return [
        {"tag": tag, "level": level, "source": source, "images": counts.get(tag, 0)}
        for tag, (level, source) in sorted(own.items())
    ]


@router.get("/tags")
async def get_tag_levels():
    """This library's own tag levels (set by hand or suggested), with image
    counts. While the filter is on, tags it hides are left out and counted
    in ``hidden``."""
    rows = await _tag_rows()
    shown = [r for r in rows if sensitivity_filter.allowed(r["tag"])]
    return {"tags": shown, "hidden": len(rows) - len(shown)}


@router.post("/tags")
async def set_tag_level(body: TagLevelPatch):
    """Set one tag's level for this library (by hand), or drop it."""
    try:
        changed = await tag_sensitivity.set_level(body.tag, body.level)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"changed": changed, "counts": await _counts()}
