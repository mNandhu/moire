"""The CRUD both preset kinds (prompt presets, LoRA activation presets) share:
a table of named text snippets keyed by a uuid, each stamped with
``updated_at``. A kind supplies its field validator and ordering."""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn, async_tx


class PresetError(ValueError):
    pass


def clean_name(patch: dict[str, Any]) -> str:
    name = str(patch.get("name") or "").strip()
    if not 1 <= len(name) <= 80:
        raise PresetError("name must be 1 to 80 characters")
    return name


def clean_text(patch: dict[str, Any]) -> str:
    text = str(patch.get("text") or "")
    if len(text) > 4000:
        raise PresetError("text is too long")
    return text.strip()


class Store:
    def __init__(
        self,
        table: sa.Table,
        clean: Callable[..., dict[str, Any]],
        order_by: list[Any],
        defaults: dict[str, Any] | None = None,
        seed: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.table = table
        self.clean = clean
        self.order_by = order_by
        self.defaults = defaults or {}
        self.seed = seed

    async def listing(self) -> list[dict[str, Any]]:
        if self.seed:
            await self.seed()
        async with async_conn() as conn:
            rows = (
                await conn.execute(sa.select(self.table).order_by(*self.order_by))
            ).mappings()
            return [dict(r) for r in rows]

    async def create(self, body: dict[str, Any]) -> dict[str, Any]:
        values = self.clean(body, new=True)
        row = {
            "_id": uuid.uuid4().hex,
            **self.defaults,
            **values,
            "updated_at": time.time(),
        }
        async with async_tx() as conn:
            await conn.execute(sa.insert(self.table).values(**row))
        return row

    async def update(
        self, preset_id: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None:
        values = self.clean(patch, new=False)
        p = self.table
        async with async_tx() as conn:
            if values:
                values["updated_at"] = time.time()
                await conn.execute(
                    sa.update(p).where(p.c._id == preset_id).values(**values)
                )
            row = (await conn.execute(sa.select(p).where(p.c._id == preset_id))).first()
        return dict(row._mapping) if row else None

    async def delete(self, preset_id: str) -> bool:
        p = self.table
        async with async_tx() as conn:
            res = await conn.execute(sa.delete(p).where(p.c._id == preset_id))
        return bool(res.rowcount)
