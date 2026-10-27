"""Reading an image's stored raw generation document (``image_gen_raw``)."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import schema as t
from . import image_tags


async def raw_for(conn: AsyncConnection, image_id: str) -> Any:
    """The raw doc of ``image_id`` (any separator spelling), or None when the
    image is unknown or carries no generation data."""
    resolved = await image_tags.resolve_image_id(conn, image_id)
    if resolved is None:
        return None
    return (
        await conn.execute(
            sa.select(t.image_gen_raw.c.raw).where(t.image_gen_raw.c._id == resolved)
        )
    ).scalar()
