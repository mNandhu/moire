"""Remix: what the Generate composer starts from when an image is remixed.

One read per image, for the viewer's Workflow line and the Remix menu: the
image's workflow (family, name, signature) so the page can tell whether it is
set up, the prompt split into characters (those with a recipe) and the rest,
and the run settings checked against what the connected ComfyUI has. An image
Moiré queued itself also returns the batch and request it came from, which
replay it exactly.
"""

from __future__ import annotations

import re
from collections.abc import Set
from typing import Any

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn
from . import comfy_models, gen_metadata, generator_setup, recipes, tag_categories
from .generation_compose import without_terms
from .generator_discovery import discover, fixed_values
from .generator_graph import SAMPLING, lora_stem
from .prompt_parse import parse_prompt
from .tag_names import canonical_name

# As many characters as one prompt takes (the composer's MAX_CHARACTERS).
MAX_CHARACTERS = 8

# A1111 extra networks written into the prompt (`<lora:name:0.7>`): ComfyUI
# would read them as words.
_NETWORK = re.compile(r"<(?:lora|lyco|hypernet):[^>]*>", re.IGNORECASE)
_WXH = re.compile(r"(\d+)\s*x\s*(\d+)")
_A1111_SIZE = re.compile(r"\bSize:\s*(\d+)\s*x\s*(\d+)", re.IGNORECASE)


def strip_networks(text: str) -> str:
    """``text`` without A1111 extra-network tags, separators tidied. Pure."""
    if not _NETWORK.search(text):
        return text
    out = _NETWORK.sub("", text)
    out = re.sub(r"(\s*,\s*){2,}", ", ", out)
    return re.sub(r"^[\s,]+|[\s,]+$", "", out)


def prompt_characters(text: str, names: Set[str]) -> list[str]:
    """Character names the prompt holds (canonical, first seen first). Pure."""
    out: list[str] = []
    for p in parse_prompt(text):
        if p.kind != "tag":
            continue
        c = canonical_name(p.text)
        if c in names and c not in out:
            out.append(c)
    return out


def a1111_size(parameters: object) -> tuple[int, int] | None:
    """The base size an A1111 image was made at (before hires). Pure."""
    m = _A1111_SIZE.search(parameters) if isinstance(parameters, str) else None
    return (int(m.group(1)), int(m.group(2))) if m else None


def _at(graph: dict[str, Any], path: Any) -> Any:
    if not isinstance(path, list) or len(path) != 2:
        return None
    return ((graph.get(str(path[0])) or {}).get("inputs") or {}).get(path[1])


def graph_settings(graph: dict[str, Any]) -> dict[str, Any]:
    """The latent size and sampling the base sampler ran with, from the
    graph's literal inputs (an upscaled output's own size is not it). Pure."""
    slots = discover(graph)["slots"]
    # The latent's literal size, or a ratio node's choice ("2:3 [832x1216
    # portrait]").
    m = _WXH.search(fixed_values(graph, {})["size"] or "")
    size = (int(m.group(1)), int(m.group(2))) if m else None
    sampling = {}
    for key in SAMPLING:
        v = _at(graph, slots.get(key))
        if v is not None and not isinstance(v, bool):
            sampling[key] = v
    return {"size": size, "sampling": sampling}


def checked_sampling(
    sampling: dict[str, Any], have: dict[str, list[str]]
) -> dict[str, Any]:
    """Sampling values the connected ComfyUI accepts: a sampler or scheduler
    it doesn't list (A1111's "DPM++ 2M Karras") is left out; before the
    first connection (no lists) nothing is judged. Pure."""
    out: dict[str, Any] = {}
    for key in ("sampler", "scheduler"):
        v = sampling.get(key)
        if isinstance(v, str) and (not have.get(key) or v in have[key]):
            out[key] = v
    steps = sampling.get("steps")
    if isinstance(steps, int) and 1 <= steps <= 200:
        out["steps"] = steps
    cfg = sampling.get("cfg")
    if isinstance(cfg, (int, float)) and 0 <= cfg <= 30:
        out["cfg"] = float(cfg)
    return out


def matched_loras(
    used: list[dict[str, Any]], table: dict[str, str | None]
) -> list[dict[str, Any]]:
    """The image's LoRAs as installed files (by stem); one ComfyUI lacks keeps
    its own name, for the Style layer to flag. Pure."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for lo in used:
        name = lo.get("name")
        if not isinstance(name, str) or not name:
            continue
        stem = lora_stem(name)
        if stem in seen:
            continue
        seen.add(stem)
        strength = lo.get("strength")
        out.append(
            {
                "name": table.get(stem) or name,
                "strength": float(strength)
                if isinstance(strength, (int, float))
                else 1.0,
                "installed": table.get(stem) is not None,
            }
        )
    return out


async def _batch_of(conn, image_id: str) -> dict[str, Any] | None:
    """The batch and request a Moiré output came from, else None."""
    row = (
        await conn.execute(
            sa.select(
                t.generation_batches.c._id,
                t.generation_batches.c.name,
                t.generation_batches.c.auto_name,
                t.generation_batches.c.generator_id,
                t.generation_batches.c.inputs,
                t.generation_requests.c.seed,
                t.generation_requests.c.images,
                t.generation_outputs.c.idx,
            )
            .select_from(
                t.generation_outputs.join(
                    t.generation_requests,
                    t.generation_requests.c._id == t.generation_outputs.c.request_id,
                ).join(
                    t.generation_batches,
                    t.generation_batches.c._id == t.generation_requests.c.batch_id,
                )
            )
            .where(t.generation_outputs.c.image_id == image_id)
            .order_by(t.generation_requests.c._id.desc())
            .limit(1)
        )
    ).first()
    if row is None or not isinstance(row.inputs, dict):
        return None
    return {
        "id": row._id,
        "name": row.name,
        "auto_name": bool(row.auto_name),
        "generator_id": row.generator_id,
        "inputs": row.inputs,
        "seed": row.seed,
        "images": row.images,
        "index": row.idx,
    }


async def remix_view(image_id: str) -> dict[str, Any] | None:
    """What Remix starts from for ``image_id``; None when it has no
    generation data."""
    async with async_conn() as conn:
        img = (
            await conn.execute(
                sa.select(t.images.c.gen, t.images.c.width, t.images.c.height).where(
                    t.images.c._id == image_id
                )
            )
        ).first()
        if img is None or not isinstance(img.gen, dict) or not img.gen.get("source"):
            return None
        raw = (
            await conn.execute(
                sa.select(t.image_gen_raw.c.raw).where(
                    t.image_gen_raw.c._id == image_id
                )
            )
        ).scalar()
        batch = await _batch_of(conn, image_id)
    gen = img.gen
    raw = raw if isinstance(raw, dict) else {}

    workflow = None
    size = None
    sampling: dict[str, Any] = {
        k: gen.get(k) for k in ("sampler", "steps", "cfg") if gen.get(k) is not None
    }
    graph = raw.get("prompt")
    if isinstance(graph, str):
        graph = gen_metadata.loads_lenient(graph)
    if gen.get("source") == "comfyui" and isinstance(graph, dict) and graph:
        try:
            _, source = await generator_setup.image_source(image_id)
        except generator_setup.SetupError:
            source = None
        if source is not None:
            workflow = {
                k: source.get(k)
                for k in ("family", "family_name", "file_name", "workflow_sig")
            }
        found = graph_settings(graph)
        size = found["size"]
        sampling = found["sampling"] or sampling
    elif gen.get("source") == "a1111":
        size = a1111_size(raw.get("parameters"))

    have = await comfy_models.installed()
    have.update(await comfy_models.sampling())
    table = {m["stem"]: m["name"] for m in await comfy_models.matching()}

    # Characters with a recipe move to Character blocks: their name and the
    # identity tags the block adds back leave the prompt. Worn things stay
    # (the Outfit block comes later).
    prompt = strip_networks(gen.get("prompt") or "")
    vocab = await tag_categories.load()
    characters: list[str] = []
    drop: set[str] = set()
    for name in prompt_characters(prompt, vocab.names):
        if len(characters) >= MAX_CHARACTERS:
            break
        r = await recipes.recipe(name)
        if r is None or r["tag"] in characters:
            continue
        characters.append(r["tag"])
        drop.add(name)
        drop.update(canonical_name(c["tag"]) for c in r["identity"] if not c["dropped"])
    if drop:
        prompt = without_terms(prompt, drop, canonical_name)

    model = gen.get("model")
    checkpoint = None
    if isinstance(model, str) and model:
        checkpoint = next(
            (
                c
                for c in have["checkpoint"]
                if c == model or lora_stem(c) == lora_stem(model)
            ),
            None,
        )

    return {
        "image_id": image_id,
        "source": gen.get("source"),
        "workflow": workflow,
        "prompt": prompt,
        "negative": strip_networks(gen.get("negative") or ""),
        "characters": characters,
        "seed": gen.get("seed") if isinstance(gen.get("seed"), int) else None,
        "width": size[0] if size else None,
        "height": size[1] if size else None,
        "sampling": checked_sampling(sampling, have),
        "checkpoint": checkpoint,
        "loras": matched_loras(gen.get("loras") or [], table),
        "batch": batch,
    }
