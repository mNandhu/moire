"""Index of the models installed in ComfyUI, and LoRA stem matching.

Refreshed from ``/object_info`` (checkpoint and LoRA combos) and
``/embeddings`` on connect and on Refresh. A library LoRA name
(``image_loras.name``, already a stem) matches an installed file by stem; a
stem two files share uses the user's pick from ``lora_choices``.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from .comfy_client import ComfyClient
from .generator_graph import lora_stem


def _combo(info: dict[str, Any], class_type: str, input_name: str) -> list[str]:
    try:
        values = info[class_type]["input"]["required"][input_name][0]
    except (KeyError, IndexError, TypeError):
        return []
    return [str(v) for v in values] if isinstance(values, list) else []


async def refresh(client: ComfyClient) -> dict[str, int]:
    checkpoints = _combo(
        await client.object_info("CheckpointLoaderSimple"),
        "CheckpointLoaderSimple",
        "ckpt_name",
    )
    loras = _combo(await client.object_info("LoraLoader"), "LoraLoader", "lora_name")
    embeddings = await client.embeddings()
    rows = (
        [{"kind": "checkpoint", "name": n, "stem": lora_stem(n)} for n in checkpoints]
        + [{"kind": "lora", "name": n, "stem": lora_stem(n)} for n in loras]
        + [{"kind": "embedding", "name": n, "stem": lora_stem(n)} for n in embeddings]
    )
    async with async_tx() as conn:
        await conn.execute(sa.delete(t.comfy_models))
        if rows:
            await conn.execute(sa.insert(t.comfy_models), rows)
    return {
        "checkpoints": len(checkpoints),
        "loras": len(loras),
        "embeddings": len(embeddings),
    }


async def installed() -> dict[str, list[str]]:
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(t.comfy_models.c.kind, t.comfy_models.c.name).order_by(
                    sa.func.lower(t.comfy_models.c.name)
                )
            )
        ).fetchall()
    out: dict[str, list[str]] = {"checkpoint": [], "lora": [], "embedding": []}
    for r in rows:
        out.setdefault(r.kind, []).append(r.name)
    return out


def match_table(
    used: list[tuple[str, int]],
    loras: list[str],
    choices: dict[str, str],
) -> list[dict[str, Any]]:
    """One row per LoRA the library uses: its stem, how many images, the
    installed files with that stem, and the file Moiré will send (None when
    not installed, or when two files share it and no pick was made). Pure."""
    by_stem: dict[str, list[str]] = defaultdict(list)
    for name in loras:
        by_stem[lora_stem(name)].append(name)
    out = []
    for stem, count in used:
        files = sorted(by_stem.get(stem, []))
        choice = choices.get(stem)
        resolved = (
            files[0] if len(files) == 1 else (choice if choice in files else None)
        )
        out.append({"stem": stem, "images": count, "files": files, "name": resolved})
    return out


async def matching() -> list[dict[str, Any]]:
    async with async_conn() as conn:
        used = (
            await conn.execute(
                sa.select(t.image_loras.c.name, sa.func.count())
                .group_by(t.image_loras.c.name)
                .order_by(sa.func.count().desc(), t.image_loras.c.name)
            )
        ).fetchall()
        rows = (
            await conn.execute(sa.select(t.lora_choices.c.stem, t.lora_choices.c.name))
        ).fetchall()
    choices = {r.stem: r.name for r in rows}
    loras = (await installed())["lora"]
    return match_table([(lora_stem(n), c) for n, c in used], loras, choices)


async def set_choice(stem: str, name: str | None) -> None:
    async with async_tx() as conn:
        await conn.execute(
            sa.delete(t.lora_choices).where(t.lora_choices.c.stem == stem)
        )
        if name:
            await conn.execute(sa.insert(t.lora_choices).values(stem=stem, name=name))
