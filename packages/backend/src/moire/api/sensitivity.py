"""The Global Sensitivity Filter's setting, and what it would hide."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn
from ..services import image_visibility, sensitivity_filter, tag_sensitivity

router = APIRouter()


class SensitivityPatch(BaseModel):
    #: general, sensitive or questionable; null (or explicit) turns it off.
    max_level: str | None


async def _counts() -> dict:
    """Images out of quarantine by level, the filter aside: ``unknown`` has
    no level yet (no rating, and no tags that vouch for one), which the
    filter hides until AI tagging gives it one."""
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
