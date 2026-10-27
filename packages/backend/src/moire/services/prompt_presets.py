"""Prompt presets: named snippets the composer's Prefix and Negative layers
pick from. A few defaults are added once (an app_settings flag), so deleting
them sticks."""

from __future__ import annotations

import time
import uuid
from typing import Any

import sqlalchemy as sa

from ..database.db import async_tx
from ..database import schema as t
from . import app_settings
from .preset_store import PresetError, Store, clean_name, clean_text

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


def clean(patch: dict[str, Any], *, new: bool) -> dict[str, Any]:
    """A preset from the API: name (1-80 chars), kind, text. Pure."""
    out: dict[str, Any] = {}
    if "name" in patch or new:
        out["name"] = clean_name(patch)
    if "kind" in patch or new:
        if patch.get("kind") not in KINDS:
            raise PresetError("kind must be positive or negative")
        out["kind"] = patch["kind"]
    if "text" in patch or new:
        out["text"] = clean_text(patch)
    return out


async def _seed() -> None:
    if await app_settings.read(FLAG):
        return
    async with async_tx() as conn:
        # Re-check inside the write transaction: two first listings can race.
        if (await conn.execute(app_settings.doc_stmt(FLAG))).scalar():
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
        await conn.execute(app_settings.upsert_stmt(FLAG, {"seeded": True}))


store = Store(
    t.prompt_presets,
    clean,
    [t.prompt_presets.c.kind, sa.func.lower(t.prompt_presets.c.name)],
    seed=_seed,
)
