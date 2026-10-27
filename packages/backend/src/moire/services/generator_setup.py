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
from . import attire, comfy_models, gen_metadata, rulesets, tag_categories
from . import workflow_family
from .model_names import model_stem
from .prompt_parse import without_terms
from .generator_discovery import check_slots, discover
from .generation_limits import clamp_per_request
from .generator_graph import SAMPLING, STOCK_LORA_LOADERS
from .prompt_parse import parse_prompt
from .tag_names import canonical_name

_PIN = re.compile(r"^prompt\.([^.]+)\.inputs\.([^.]+)$")


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
        family = workflow_family.family_key(raw) or None
        label = None
        if family:
            workflow = raw.get("workflow")
            nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
            label = (
                await workflow_family.family_labels(conn, [family], {family: nodes})
            )[family]
        name = label["name"] if label else None
        # An unnamed family: the imported workflow file it matches.
        file_name = label["file_name"] if label and not name else None
        pins = await rulesets.doc_for(conn, row.workflow_sig)
    source = {
        "kind": "image",
        "image_id": image_id,
        "family": family,
        "family_name": name,
        "file_name": file_name,
        "workflow_sig": row.workflow_sig,
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
    graph: dict[str, Any],
    source: dict[str, Any],
    slots: dict[str, Any] | None = None,
    carry_from: tuple[dict[str, Any], dict[str, Any]] | None = None,
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
    lora_stems = {model_stem(n) for n in have["lora"]}
    for lo in d["found"]["loras"]:
        lo["installed"] = model_stem(lo["name"]) in lora_stems if have["lora"] else None
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
    chosen = (
        slots
        if slots is not None
        else carry_slots(carry_from[0], carry_from[1], graph, proposed)
        if carry_from
        else proposed
    )
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
        out["per_request"] = clamp_per_request(n)
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
    if raw.get("lora_text") is True:
        if out.get("lora_model"):
            raise SetupError(
                "LoRAs go either at the insertion point or into the prompt"
            )
        out["lora_text"] = True
    return out


def clean_defaults(raw: Any) -> dict[str, str]:
    d = raw if isinstance(raw, dict) else {}
    return {"base": str(d.get("base") or ""), "negative": str(d.get("negative") or "")}


def public_source(source: dict[str, Any]) -> dict[str, Any]:
    """A source as the client sees it: no ruleset pins, defaults or editor nodes."""
    return {k: v for k, v in source.items() if k not in ("pins", "defaults")}


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


async def newer_version(gen: dict[str, Any]) -> dict[str, Any] | None:
    """A newer version of the workflow in the library: the family's newest
    version (by when it was first used, counting only images Moire didn't
    make: its own outputs carry the family but a graph it edited) when it is
    newer than the one this workflow was set up from. ``{image_id,
    workflow_sig, versions}`` (``versions``: how many the family has), else
    None."""
    src = gen.get("source") or {}
    if src.get("kind") != "image" or not src.get("family"):
        return None
    images, outs = t.images, t.generation_outputs
    made_here = sa.select(outs.c.image_id).where(outs.c.image_id.isnot(None))
    async with async_conn() as conn:
        sigs = await workflow_family.family_sigs(conn, src["family"])
        if not sigs:
            return None
        firsts = (
            await conn.execute(
                sa.select(images.c.gen_workflow_sig, sa.func.min(images.c.mtime))
                .where(
                    images.c.gen_workflow_sig.in_(sigs),
                    images.c._id.not_in(made_here),
                )
                .group_by(images.c.gen_workflow_sig)
            )
        ).fetchall()
        order = [r[0] for r in sorted(firsts, key=lambda r: (r[1] or 0, r[0]))]
        if not order or order[-1] == src.get("workflow_sig"):
            return None
        image_id = (
            await conn.execute(
                sa.select(images.c._id)
                .where(
                    images.c.gen_workflow_sig == order[-1],
                    images.c._id.not_in(made_here),
                )
                .order_by(
                    sa.func.coalesce(images.c.mtime, 0).desc(), images.c._id.desc()
                )
                .limit(1)
            )
        ).scalar()
    return {
        "image_id": image_id,
        "workflow_sig": order[-1],
        "versions": len(order),
    }


def carry_slots(
    old: dict[str, Any],
    old_graph: dict[str, Any],
    graph: dict[str, Any],
    proposed: dict[str, Any],
) -> dict[str, Any]:
    """A workflow's slots moved onto a newer version of its graph: each one
    kept where its node id still names the same kind of node there (ComfyUI
    keeps ids across edits) and the input still fits; the rest come from the
    new proposal. Pure."""

    def same_node(ref: Any) -> bool:
        nid = str(ref[0])
        return nid in graph and (old_graph.get(nid) or {}).get("class_type") == graph[
            nid
        ].get("class_type")

    out = dict(proposed)
    links = set(proposed.get("replace_links") or [])
    for key, value in old.items():
        if value is None or key in (
            "seeds",
            "drop_loras",
            "replace_links",
            "per_request",
        ):
            continue
        if isinstance(value, list) and value and not same_node(value):
            continue
        trial = {**out, key: value}
        if key in ("positive", "negative"):
            want = key in (old.get("replace_links") or [])
            trial["replace_links"] = sorted(
                (links - {key}) | ({key} if want else set())
            )
        if not set(check_slots(graph, trial)) - set(check_slots(graph, out)):
            out[key] = value
            if key in ("positive", "negative"):
                links = set(trial["replace_links"])
    out["replace_links"] = sorted(links)
    if old.get("per_request") and out.get("batch_size") == old.get("batch_size"):
        out["per_request"] = old["per_request"]
    seeds = [
        p
        for p in old.get("seeds") or []
        if same_node(p) and not check_slots(graph, {**out, "seeds": [p]})
    ]
    if seeds:
        out["seeds"] = seeds
    drops = [
        n
        for n in old.get("drop_loras") or []
        if same_node([n]) and graph[str(n)].get("class_type") in STOCK_LORA_LOADERS
    ]
    out["drop_loras"] = sorted(set(drops) | set(proposed.get("drop_loras") or []))
    return out


async def update(gen: dict[str, Any], patch: dict[str, Any]) -> None:
    """Rename, set new slots / defaults, or move to a newer version of the
    graph (``source``: its image). New slots or graph reset the test gate."""
    values: dict[str, Any] = {"updated_at": time.time()}
    if isinstance(patch.get("name"), str) and patch["name"].strip():
        values["name"] = patch["name"].strip()
    graph = gen["graph"]
    if isinstance(patch.get("source"), dict) and patch["source"].get("image_id"):
        if "slots" not in patch:
            raise SetupError("A new version needs its slots")
        graph, source = await image_source(str(patch["source"]["image_id"]))
        if await has_work(gen["_id"]):
            raise SetupError("Wait for its batches to finish or cancel them first")
        values.update(
            graph=graph,
            source={**source, "defaults": (gen.get("source") or {}).get("defaults")},
            ready=False,
            test=None,
        )
        gen = {**gen, "source": values["source"]}
    if "slots" in patch:
        slots = clean_slots(patch["slots"])
        problems = check_slots(graph, slots)
        if problems:
            raise SetupError(problems[0])
        if slots != gen["slots"] or "graph" in values:
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
