"""Generator rows: reading one, with the built-in created or refreshed on
first read."""

from __future__ import annotations

import time
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import builtin_generator


async def load_generator(generator_id: str) -> dict[str, Any] | None:
    """A Generator row; the built-in is created on first read."""
    async with async_conn() as conn:
        row = (
            await conn.execute(
                sa.select(t.generators).where(t.generators.c._id == generator_id)
            )
        ).first()
    if row is not None:
        gen = dict(row._mapping)
        if gen["kind"] == "builtin" and (
            gen["graph"] != builtin_generator.graph()
            or gen["slots"] != builtin_generator.slots()
        ):
            # Moiré's own graph: a stored copy from before a new slot is updated.
            gen["graph"] = builtin_generator.graph()
            gen["slots"] = builtin_generator.slots()
            async with async_tx() as conn:
                await conn.execute(
                    sa.update(t.generators)
                    .where(t.generators.c._id == generator_id)
                    .values(graph=gen["graph"], slots=gen["slots"])
                )
        return gen
    if generator_id != builtin_generator.BUILTIN_ID:
        return None
    now = time.time()
    doc = {
        "_id": builtin_generator.BUILTIN_ID,
        "name": builtin_generator.BUILTIN_NAME,
        "kind": "builtin",
        "source": None,
        "graph": builtin_generator.graph(),
        "slots": builtin_generator.slots(),
        "ready": False,
        "test": None,
        "created_at": now,
        "updated_at": now,
    }
    async with async_tx() as conn:
        await conn.execute(
            sa.insert(t.generators).prefix_with("OR IGNORE").values(**doc)
        )
    return doc
