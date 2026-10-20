"""Custom Generators: from a library image's workflow or an uploaded
*Export (API)* file to a saved Generator. Discovery itself is pure
(:mod:`services.generator_discovery`); this module reads the source graph,
adds what needs the library (the family's name, the ruleset's prompt pins,
character tags in the default Base), and saves.

A Generator's graph is a snapshot: kept as it came from the source, never
edited, so "update from latest" can compare it with the family's newest graph.
Changing its slots puts it back behind the test-run gate.
"""

from __future__ import annotations

import re
import secrets
import time
from typing import Any

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn, async_tx
from . import attire, comfy_models, gen_metadata, tag_categories
from .generator_graph import lora_stem
from .generation_compose import without_terms
from .generator_discovery import check_slots, discover
from .generator_graph import SAMPLING
from .prompt_parse import parse_prompt
from .tag_names import canonical_name

_PIN = re.compile(r"^prompt\.([^.]+)\.inputs\.([^.]+)$")
# Slot keys a client may set; anything else in a PUT is dropped.
_SLOT_KEYS = (
    "positive",
    "negative",
    "replace_links",
    "seeds",
    "width",
    "height",
    "batch_size",
    "per_request",
    "checkpoint",
    "sampler",
    "scheduler",
    "steps",
    "cfg",
    "lora_model",
    "lora_clip",
    "drop_loras",
)


class SetupError(ValueError):
    """The source can't become a Generator (shown to the user as is)."""


def parse_upload(doc: Any) -> dict[str, Any]:
    """An uploaded file's API graph. Editor-format files (``nodes`` +
    ``links``) are refused with a hint: only ComfyUI's frontend can turn them
    into an API graph."""
    if isinstance(doc, dict) and isinstance(doc.get("nodes"), list) and "links" in doc:
        raise SetupError(
            "This is an editor workflow. In ComfyUI, use Workflow > Export (API)."
        )
    if isinstance(doc, dict) and isinstance(doc.get("prompt"), dict):
        doc = doc["prompt"]  # a raw doc, or a /history entry's prompt
    if not isinstance(doc, dict) or not doc:
        raise SetupError("This file isn't a ComfyUI API workflow")
    for node in doc.values():
        if not (
            isinstance(node, dict)
            and isinstance(node.get("class_type"), str)
            and isinstance(node.get("inputs"), dict)
        ):
            raise SetupError("This file isn't a ComfyUI API workflow")
    # Only what ComfyUI runs: editor state like `is_changed: NaN` isn't JSON.
    return {
        str(k): gen_metadata.sanitize_json(
            {key: v[key] for key in ("class_type", "inputs", "_meta") if key in v}
        )
        for k, v in doc.items()
    }


async def image_source(image_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """An image's API graph and where it came from: the image, its workflow
    family (editor graph id) and signature, and the family's name."""
    async with async_conn() as conn:
        row = (
            await conn.execute(
                sa.select(t.image_gen_raw.c.raw, t.image_gen_raw.c.workflow_sig).where(
                    t.image_gen_raw.c._id == image_id
                )
            )
        ).first()
        raw = row.raw if row is not None else None
        graph = raw.get("prompt") if isinstance(raw, dict) else None
        if isinstance(graph, str):
            graph = gen_metadata.loads_lenient(graph)
        if not isinstance(graph, dict) or not graph:
            raise SetupError("This image has no ComfyUI workflow to run")
        workflow = raw.get("workflow") if isinstance(raw.get("workflow"), dict) else {}
        family = workflow.get("id") if isinstance(workflow.get("id"), str) else None
        name = None
        if family:
            name = (
                await conn.execute(
                    sa.select(t.workflow_names.c.name).where(
                        t.workflow_names.c.workflow_id == family
                    )
                )
            ).scalar()
        file_name = None
        if family and not name:
            # An unnamed family: the imported workflow file it matches.
            files = [
                (r.filename, list(r.node_types or []))
                for r in (
                    await conn.execute(
                        sa.select(
                            t.workflow_files.c.filename, t.workflow_files.c.node_types
                        ).where(t.workflow_files.c.workflow_id == family)
                    )
                ).fetchall()
            ]
            nodes = workflow.get("nodes")
            match = gen_metadata.match_workflow_file(
                gen_metadata.editor_node_types(
                    {"nodes": nodes} if isinstance(nodes, list) else None
                ),
                files,
            )
            file_name = match[0] if match else None
        pins = (
            await conn.execute(
                sa.select(t.gen_rulesets.c.doc).where(
                    t.gen_rulesets.c.sig == row.workflow_sig
                )
            )
        ).scalar()
    source = {
        "kind": "image",
        "image_id": image_id,
        "family": family,
        "family_name": name,
        "file_name": file_name,
        "workflow_sig": row.workflow_sig,
        # The editor graph's node ids and types, without widget values: sent
        # with each prompt so outputs join this family (and match its file).
        "editor_nodes": [
            {"id": n.get("id"), "type": n.get("type")}
            for n in (workflow.get("nodes") or [])
            if isinstance(n, dict)
        ],
        "pins": (pins or {}).get("fields") if isinstance(pins, dict) else None,
    }
    return parse_upload(graph), source


def _pinned(
    graph: dict[str, Any], pins: dict[str, Any] | None, field: str
) -> list[Any] | None:
    """A ruleset pin on a literal input of the graph, as a slot path."""
    for path in (pins or {}).get(field) or []:
        m = _PIN.match(path) if isinstance(path, str) else None
        if m and isinstance(
            ((graph.get(m.group(1)) or {}).get("inputs") or {}).get(m.group(2)), str
        ):
            return [m.group(1), m.group(2)]
    return None


def _offer(base: str, vocab: tag_categories.Vocab) -> list[str]:
    """Tags in the default Base that the Character and Outfit blocks add at
    queue time: character names, their body features (when a character is
    there), worn things. As written in the Base, in order."""
    tags = [p.text for p in parse_prompt(base) if p.kind == "tag"]
    canon = [canonical_name(x) for x in tags]
    has_character = any(c in vocab.names for c in canon)
    out = []
    for written, c in zip(tags, canon):
        if (
            c in vocab.names
            or attire.is_attire(c)
            or (has_character and attire.is_identity(c))
        ):
            if written not in out:
                out.append(written)
    return out


def _text_at(
    graph: dict[str, Any], path: list[Any] | None, found: dict[str, Any] | None
) -> str:
    if found and path == found.get("path"):
        return found.get("text") or ""
    value = (
        ((graph.get(str(path[0])) or {}).get("inputs") or {}).get(path[1])
        if path
        else None
    )
    return value if isinstance(value, str) else ""


async def setup_view(
    graph: dict[str, Any], source: dict[str, Any], slots: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Everything the setup page shows: discovery, the slots (``slots`` when
    editing a saved Generator, else the proposal), the default Base and
    negative (a saved Generator's own, from ``source``) with the
    Remove-from-Base offer, and what still blocks saving."""
    d = discover(graph)
    proposed = dict(d["slots"])
    for side, field in (("positive", "prompt"), ("negative", "negative")):
        pin = _pinned(graph, source.get("pins"), field)
        if pin and side not in proposed:
            proposed[side] = pin
            d["found"][side] = {"path": pin, "replaces_link": False, "from": "rule"}
    # What the connected ComfyUI has (empty before the first connection: then
    # nothing is judged missing).
    have = await comfy_models.installed()
    lora_stems = {lora_stem(n) for n in have["lora"]}
    for lo in d["found"]["loras"]:
        lo["installed"] = lora_stem(lo["name"]) in lora_stems if have["lora"] else None
    ckpt = d["found"].get("checkpoint")
    if ckpt:
        ckpt["installed"] = (
            ckpt["value"] in have["checkpoint"] if have["checkpoint"] else None
        )
        if ckpt["installed"] is False:
            # Its own isn't there: choosing one in Generate is the way to run it.
            proposed["checkpoint"] = ckpt["path"]
    missing = [lo["node"] for lo in d["found"]["loras"] if lo["installed"] is False]
    if missing:
        proposed["drop_loras"] = missing
    chosen = slots if slots is not None else proposed
    saved = source.get("defaults") if isinstance(source.get("defaults"), dict) else None
    base = (
        saved["base"]
        if saved
        else _text_at(graph, chosen.get("positive"), d["found"].get("positive"))
    )
    negative = (
        saved["negative"]
        if saved
        else _text_at(graph, chosen.get("negative"), d["found"].get("negative"))
    )
    vocab = await tag_categories.load()
    offer = _offer(base, vocab)
    drop = {canonical_name(x) for x in offer}
    return {
        **d,
        "proposed": proposed,
        "slots": chosen,
        "source": public_source(source),
        "defaults": {"base": base, "negative": negative},
        "offer": offer,
        "base_without": without_terms(base, drop, canonical_name) if offer else base,
        "problems": check_slots(graph, chosen),
    }


def _path(value: Any) -> list[Any] | None:
    """``[node id, input name]``, or None when it isn't one."""
    if (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], str)
    ):
        return [str(value[0]), value[1]]
    return None


def _ref(value: Any) -> list[Any] | None:
    """``[node id, output index]``, or None when it isn't one."""
    if (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
    ):
        return [str(value[0]), value[1]]
    return None


def clean_slots(raw: Any) -> dict[str, Any]:
    """A client's slots, shape checked. Raises SetupError on a bad one."""
    if not isinstance(raw, dict):
        raise SetupError("Slots must be an object")
    out: dict[str, Any] = {}
    for key in (
        "positive",
        "negative",
        "width",
        "height",
        "batch_size",
        "checkpoint",
        *SAMPLING,
    ):
        if raw.get(key) is None:
            continue
        path = _path(raw[key])
        if path is None:
            raise SetupError(f"Bad path for {key}")
        out[key] = path
    seeds = raw.get("seeds") or []
    if not isinstance(seeds, list) or any(_path(p) is None for p in seeds):
        raise SetupError("Bad seed inputs")
    out["seeds"] = [_path(p) for p in seeds]
    links = raw.get("replace_links") or []
    out["replace_links"] = [
        k
        for k in (links if isinstance(links, list) else [])
        if k in ("positive", "negative")
    ]
    if raw.get("per_request") is not None:
        n = raw["per_request"]
        if not isinstance(n, int) or isinstance(n, bool):
            raise SetupError("Images per request must be a whole number")
        out["per_request"] = max(1, min(64, n))
    for key in ("lora_model", "lora_clip"):
        if raw.get(key) is None:
            continue
        ref = _ref(raw[key])
        if ref is None:
            raise SetupError("Bad LoRA insertion point")
        out[key] = ref
    drops = raw.get("drop_loras") or []
    if not isinstance(drops, list) or not all(isinstance(n, (str, int)) for n in drops):
        raise SetupError("Bad LoRAs to leave out")
    out["drop_loras"] = [str(n) for n in drops]
    if out.get("lora_clip") and not out.get("lora_model"):
        raise SetupError("A CLIP insertion point needs a model one")
    return out


def clean_defaults(raw: Any) -> dict[str, str]:
    d = raw if isinstance(raw, dict) else {}
    return {"base": str(d.get("base") or ""), "negative": str(d.get("negative") or "")}


def public_source(source: dict[str, Any]) -> dict[str, Any]:
    """A source as the client sees it: no ruleset pins, defaults or editor nodes."""
    return {
        k: v for k, v in source.items() if k not in ("pins", "defaults", "editor_nodes")
    }


async def has_work(gen_id: str) -> bool:
    """Whether a batch on this Generator still has requests to send: their
    graph is built from its slots at submit time."""
    async with async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.generation_batches.c._id)
                .where(
                    t.generation_batches.c.generator_id == gen_id,
                    t.generation_batches.c.state == "active",
                )
                .limit(1)
            )
        ).first() is not None


async def create(
    graph: dict[str, Any],
    source: dict[str, Any],
    name: str,
    slots: Any,
    defaults: dict[str, str],
) -> str:
    slots = clean_slots(slots)
    problems = check_slots(graph, slots)
    if problems:
        raise SetupError(problems[0])
    gen_id = "g" + secrets.token_hex(5)
    now = time.time()
    async with async_tx() as conn:
        await conn.execute(
            sa.insert(t.generators).values(
                _id=gen_id,
                name=name.strip() or "Workflow",
                kind="custom",
                # Pins kept: editing later proposes what the ruleset said.
                source={**source, "defaults": clean_defaults(defaults)},
                graph=graph,
                slots=slots,
                ready=False,
                test=None,
                created_at=now,
                updated_at=now,
            )
        )
    return gen_id


async def update(gen: dict[str, Any], patch: dict[str, Any]) -> None:
    """Rename, or set new slots / defaults. New slots reset the test-run gate."""
    values: dict[str, Any] = {"updated_at": time.time()}
    if isinstance(patch.get("name"), str) and patch["name"].strip():
        values["name"] = patch["name"].strip()
    if "slots" in patch:
        slots = clean_slots(patch["slots"])
        problems = check_slots(gen["graph"], slots)
        if problems:
            raise SetupError(problems[0])
        if slots != gen["slots"]:
            if await has_work(gen["_id"]):
                raise SetupError("Wait for its batches to finish or cancel them first")
            values.update(slots=slots, ready=False, test=None)
    if isinstance(patch.get("defaults"), dict):
        values["source"] = {
            **(gen.get("source") or {}),
            "defaults": clean_defaults(patch["defaults"]),
        }
    async with async_tx() as conn:
        await conn.execute(
            sa.update(t.generators)
            .where(t.generators.c._id == gen["_id"])
            .values(**values)
        )


async def delete(gen_id: str) -> bool:
    if await has_work(gen_id):
        raise SetupError("Wait for its batches to finish or cancel them first")
    async with async_tx() as conn:
        res = await conn.execute(
            sa.delete(t.generators).where(
                t.generators.c._id == gen_id, t.generators.c.kind == "custom"
            )
        )
    return bool(res.rowcount)


async def custom_ids() -> list[str]:
    async with async_conn() as conn:
        rows = await conn.execute(
            sa.select(t.generators.c._id)
            .where(t.generators.c.kind == "custom")
            .order_by(t.generators.c.created_at)
        )
        return [r[0] for r in rows.fetchall()]
