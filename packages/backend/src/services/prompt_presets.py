"""Prompt presets: named snippets the composer's Prefix and Negative layers
pick from. A few defaults are added once (an app_settings flag), so deleting
them sticks."""

from __future__ import annotations

import time
import uuid
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t

KINDS = ("positive", "negative")
FLAG = "prompt_presets"
DEFAULTS = [
    (
        "Illustrious quality",
        "positive",
        "masterpiece, best quality, amazing quality, absurdres, newest, very aesthetic",
    ),
    (
        "Pony score",
        "positive",
        "score_9, score_8_up, score_7_up, source_anime",
    ),
    (
        "Illustrious negative",
        "negative",
        "lowres, worst quality, bad quality, bad anatomy, bad hands, jpeg artifacts, "
        "signature, watermark, username, artist name",
    ),
]


class PresetError(ValueError):
    pass


def clean(patch: dict[str, Any], *, new: bool) -> dict[str, Any]:
    """A preset from the API: name (1-80 chars), kind, text. Pure."""
    out: dict[str, Any] = {}
    if "name" in patch or new:
        name = str(patch.get("name") or "").strip()
        if not 1 <= len(name) <= 80:
            raise PresetError("name must be 1 to 80 characters")
        out["name"] = name
    if "kind" in patch or new:
        if patch.get("kind") not in KINDS:
            raise PresetError("kind must be positive or negative")
        out["kind"] = patch["kind"]
    if "text" in patch or new:
        text = str(patch.get("text") or "")
        if len(text) > 4000:
            raise PresetError("text is too long")
        out["text"] = text.strip()
    return out


async def _seed() -> None:
    async with async_tx() as conn:
        done = (
            await conn.execute(
                sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == FLAG)
            )
        ).scalar()
        if done:
            return
        now = time.time()
        await conn.execute(
            sa.insert(t.prompt_presets),
            [
                {
                    "_id": uuid.uuid4().hex,
                    "name": n,
                    "kind": k,
                    "text": x,
                    "updated_at": now,
                }
                for n, k, x in DEFAULTS
            ],
        )
        await conn.execute(
            sa.insert(t.app_settings).values(_id=FLAG, doc={"seeded": True})
        )


async def listing() -> list[dict[str, Any]]:
    await _seed()
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(t.prompt_presets).order_by(
                    t.prompt_presets.c.kind, sa.func.lower(t.prompt_presets.c.name)
                )
            )
        ).mappings()
        return [dict(r) for r in rows]


async def create(body: dict[str, Any]) -> dict[str, Any]:
    values = clean(body, new=True)
    row = {"_id": uuid.uuid4().hex, **values, "updated_at": time.time()}
    async with async_tx() as conn:
        await conn.execute(sa.insert(t.prompt_presets).values(**row))
    return row


async def update(preset_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    values = clean(patch, new=False)
    p = t.prompt_presets
    async with async_tx() as conn:
        if values:
            values["updated_at"] = time.time()
            await conn.execute(
                sa.update(p).where(p.c._id == preset_id).values(**values)
            )
        row = (await conn.execute(sa.select(p).where(p.c._id == preset_id))).first()
    return dict(row._mapping) if row else None


async def delete(preset_id: str) -> bool:
    p = t.prompt_presets
    async with async_tx() as conn:
        res = await conn.execute(sa.delete(p).where(p.c._id == preset_id))
    return bool(res.rowcount)
