"""Generator setup: what Moiré can find in a ComfyUI API graph. Pure, no I/O.

:func:`discover` reads a graph and proposes slots (see
:mod:`services.generator_graph` for the slot shapes) plus what the setup page
lists for the user to pick from: every text input for the node picker, the
seed inputs grouped by value, the outputs. :func:`check_slots` says what
still stops a set of slots from being saved.

Everything starts at the *base sampler*: the sampler whose latent doesn't come
out of another sampler (a hires pass or a detailer runs after it). Prompts,
size, sampling settings and the LoRA insertion point are read off it.
"""

from __future__ import annotations

import re
from typing import Any

from . import gen_metadata
from .generator_graph import SAMPLING, Graph, _is_link, has_save_image, lora_insertion

# Inputs a sampling slot maps to on a KSampler-like node.
_SAMPLING_INPUTS = {
    "sampler": "sampler_name",
    "scheduler": "scheduler",
    "steps": "steps",
    "cfg": "cfg",
}
_SEED_INPUTS = ("seed", "noise_seed")
# Where a seed / primitive node keeps its number when a seed input links to it.
_NUMBER_INPUTS = ("seed", "noise_seed", "value", "int", "number")
# Where a text node keeps its text when an encoder's text links to it.
_TEXT_INPUTS = ("text", "string", "value", "prompt", "text_g", "text_l")
# String inputs that are never prompt text (file names, modes, choices).
_NOT_TEXT = re.compile(
    r"(_name|^ckpt_name|^filename_prefix|^sampler_name|^scheduler|^mode.*|^device.*"
    r"|^upload|^image|^ratio_selected|^delimiter|^separator|_regex|^crop|^method"
    r"|^upscale_method|^sampling|^trigger|^key_path|^value_type|^outputs|^enabled"
    r"|^title|^format|^extension|^weight_interpretation|^token_normalization"
    r"|_hint|_mode|_url|^workflow|_use_negative)$"
)
_CONDITIONING = re.compile(r"conditioning|^positive$|^negative$|^cond")
_MODEL_LOADER = re.compile(
    r"checkpointloader|unetloader|loadcheckpoint|diffusersloader", re.I
)


def _title(graph: Graph, node_id: str) -> str:
    node = graph.get(node_id) or {}
    meta = node.get("_meta")
    title = meta.get("title") if isinstance(meta, dict) else None
    return str(title or node.get("class_type") or node_id)


def _inputs(graph: Graph, node_id: str) -> dict[str, Any]:
    node = graph.get(str(node_id))
    inp = node.get("inputs") if isinstance(node, dict) else None
    return inp if isinstance(inp, dict) else {}


def _upstream(graph: Graph, start: Any) -> set[str]:
    """Every node a link (or node id) depends on, itself included."""
    todo = [str(start[0]) if _is_link(start) else str(start)]
    seen: set[str] = set()
    while todo:
        nid = todo.pop()
        if nid in seen or nid not in graph:
            continue
        seen.add(nid)
        todo.extend(str(v[0]) for v in _inputs(graph, nid).values() if _is_link(v))
    return seen


def _is_sampler(graph: Graph, node_id: str) -> bool:
    ct = str((graph.get(node_id) or {}).get("class_type", "")).lower()
    inp = _inputs(graph, node_id)
    return "sampler" in ct and ("positive" in inp or "latent_image" in inp)


def base_sampler(graph: Graph) -> str | None:
    """The first sampler of the graph: one with a latent that no other sampler
    made (KSampler before its hires pass). None when the graph has none (a
    remote or post-processing workflow)."""
    samplers = [nid for nid in graph if _is_sampler(graph, nid)]
    for nid in samplers:
        latent = _inputs(graph, nid).get("latent_image")
        before = _upstream(graph, latent) if _is_link(latent) else set()
        if not any(s in before for s in samplers if s != nid):
            return nid
    return samplers[0] if samplers else None


def _text_source(
    graph: Graph, ref: Any, seen: set[str] | None = None
) -> list[Any] | None:
    """The literal input a text link reads from (a Text / String / Primitive
    node), or None when the text is built at run time (joined, captioned)."""
    seen = seen or set()
    nid = str(ref[0])
    if nid in seen:
        return None
    seen.add(nid)
    inp = _inputs(graph, nid)
    texts = [(k, inp[k]) for k in _TEXT_INPUTS if k in inp]
    if len(texts) != 1:
        return None
    key, value = texts[0]
    if isinstance(value, str):
        return [nid, key]
    if _is_link(value):
        return _text_source(graph, value, seen)
    return None


def _cond_inputs(graph: Graph, ref: Any) -> list[Any]:
    """The conditioning links a conditioning output comes from. A node with
    both a positive and a negative input (ControlNet Apply Advanced) passes
    them through as outputs 0 and 1: only the matching one counts."""
    inp = _inputs(graph, ref[0])
    if _is_link(inp.get("positive")) and _is_link(inp.get("negative")):
        return [inp["negative"] if int(ref[1]) == 1 else inp["positive"]]
    return [
        v for k, v in sorted(inp.items()) if _CONDITIONING.search(k) and _is_link(v)
    ]


def _prompt_upstream(graph: Graph, ref: Any) -> set[str]:
    """Every node one side of the sampler's conditioning depends on: like
    :func:`_upstream`, but through a positive / negative pass-through node
    only along its own side."""
    seen: set[str] = set()
    todo = [ref]
    while todo:
        r = todo.pop()
        nid = str(r[0])
        if nid in seen or nid not in graph:
            continue
        inp = _inputs(graph, nid)
        if _is_link(inp.get("positive")) and _is_link(inp.get("negative")):
            seen.add(nid)
            others = [
                v
                for k, v in inp.items()
                if _is_link(v) and k not in ("positive", "negative")
            ]
            todo.extend([*_cond_inputs(graph, r), *others])
        else:
            seen |= _upstream(graph, r)
    return seen


def _encoder(graph: Graph, ref: Any) -> str | None:
    """The text encoder a conditioning link starts from, through combine /
    ControlNet nodes (first conditioning input each time)."""
    seen: set[str] = set()
    while _is_link(ref):
        nid = str(ref[0])
        if nid in seen or nid not in graph:
            return None
        seen.add(nid)
        inp = _inputs(graph, nid)
        if any(k in inp for k in ("text", "text_g", "text_l")):
            return nid
        ref = next(iter(_cond_inputs(graph, ref)), None)
    return None


def prompt_slot(graph: Graph, sampler: str, side: str) -> dict[str, Any] | None:
    """Where the sampler's positive / negative text can be written:
    ``{"path", "replaces_link", "text"}``. A literal ``text`` on the encoder,
    else the one text node it reads from. A text built at run time (a concat)
    gives the encoder's own input with ``replaces_link``: writing there drops
    the join, so it is offered but not chosen for the user."""
    enc = _encoder(graph, _inputs(graph, sampler).get(side))
    if enc is None:
        return None
    inp = _inputs(graph, enc)
    key = next((k for k in ("text", "text_g") if k in inp), None)
    if key is None:
        return None
    value = inp[key]
    text = gen_metadata._resolve_text(graph, [enc, 0])
    if isinstance(value, str):
        return {"path": [enc, key], "replaces_link": False, "text": value}
    if _is_link(value):
        src = _text_source(graph, value)
        if src is not None:
            return {
                "path": src,
                "replaces_link": False,
                "text": _inputs(graph, src[0])[src[1]],
            }
        return {"path": [enc, key], "replaces_link": True, "text": text}
    return None


def text_inputs(graph: Graph, sampler: str | None) -> list[dict[str, Any]]:
    """Everything the node picker lists: each literal text input, plus each
    encoder whose text is a link (writing there replaces the link). ``reaches``
    says which of the sampler's prompts it feeds (positive / negative / both,
    or None: used elsewhere, a detailer's own prompt, a file name)."""
    pos = neg = set()
    if sampler is not None:
        s_inp = _inputs(graph, sampler)
        pos = (
            _prompt_upstream(graph, s_inp.get("positive"))
            if _is_link(s_inp.get("positive"))
            else set()
        )
        neg = (
            _prompt_upstream(graph, s_inp.get("negative"))
            if _is_link(s_inp.get("negative"))
            else set()
        )
    out = []
    for nid in graph:
        inp = _inputs(graph, nid)
        for key, value in inp.items():
            literal = (
                isinstance(value, str)
                and not _NOT_TEXT.search(key)
                # An unused join input ("text3": "") is no place for a prompt.
                and (bool(value.strip()) or key in _TEXT_INPUTS)
            )
            joined = (
                key in ("text", "text_g") and _is_link(value) and _encodes(graph, nid)
            )
            if not (literal or joined):
                continue
            reaches = (
                "both"
                if nid in pos and nid in neg
                else "positive"
                if nid in pos
                else "negative"
                if nid in neg
                else None
            )
            out.append(
                {
                    "path": [nid, key],
                    "class_type": (graph[nid] or {}).get("class_type"),
                    "title": _title(graph, nid),
                    "text": value
                    if literal
                    else gen_metadata._resolve_text(graph, [nid, 0]),
                    "replaces_link": joined,
                    "reaches": reaches,
                }
            )
    return out


def _encodes(graph: Graph, node_id: str) -> bool:
    """A text encoder: turns text into conditioning (has a clip input)."""
    return "clip" in _inputs(graph, node_id)


def seed_groups(graph: Graph) -> list[dict[str, Any]]:
    """Every seed input, grouped by the value it has (one group per value).
    A seed linked to a seed / primitive node is written on that node, once,
    however many samplers read it."""
    by_path: dict[tuple[str, str], dict[str, Any]] = {}
    for nid in graph:
        for key in _SEED_INPUTS:
            value = _inputs(graph, nid).get(key)
            path: list[Any] | None = None
            if isinstance(value, int) and not isinstance(value, bool):
                path = [nid, key]
            elif _is_link(value):
                src = str(value[0])
                skey = next(
                    (
                        k
                        for k in _NUMBER_INPUTS
                        if isinstance(_inputs(graph, src).get(k), int)
                    ),
                    None,
                )
                path = [src, skey] if skey else None
            if path is None:
                continue
            entry = by_path.setdefault(
                (path[0], path[1]),
                {
                    "path": path,
                    "value": _inputs(graph, path[0])[path[1]],
                    "used_by": [],
                },
            )
            entry["used_by"].append({"node": nid, "title": _title(graph, nid)})
    groups: dict[int, dict[str, Any]] = {}
    for entry in by_path.values():
        # A seed node read by samplers lists them, not itself.
        others = [u for u in entry["used_by"] if u["node"] != entry["path"][0]]
        entry["used_by"] = others or entry["used_by"]
        g = groups.setdefault(entry["value"], {"value": entry["value"], "inputs": []})
        g["inputs"].append(entry)
    # Most shared first: the one seed most passes read is the likely main one.
    return sorted(
        groups.values(), key=lambda g: -sum(len(e["used_by"]) for e in g["inputs"])
    )


def _latent(graph: Graph, sampler: str) -> str | None:
    """The node that sizes the sampler's latent: the latent link, followed
    through latent-only nodes (upscale, repeat) to one with a size or batch."""
    ref = _inputs(graph, sampler).get("latent_image")
    seen: set[str] = set()
    while _is_link(ref):
        nid = str(ref[0])
        if nid in seen or nid not in graph:
            return None
        seen.add(nid)
        inp = _inputs(graph, nid)
        if any(k in inp for k in ("width", "height", "batch_size")):
            return nid
        ref = next(
            (
                inp[k]
                for k in ("samples", "latent", "latent_image")
                if _is_link(inp.get(k))
            ),
            None,
        )
    return None


def _literal_path(
    graph: Graph, node_id: str | None, key: str, kind: Any
) -> list[Any] | None:
    if node_id is None:
        return None
    value = _inputs(graph, node_id).get(key)
    if isinstance(value, kind) and not isinstance(value, bool):
        return [node_id, key]
    return None


def model_loader(graph: Graph, sampler: str) -> str | None:
    """The checkpoint / UNET loader the sampler's model comes from."""
    ref = _inputs(graph, sampler).get("model")
    seen: set[str] = set()
    while _is_link(ref):
        nid = str(ref[0])
        if nid in seen or nid not in graph:
            return None
        seen.add(nid)
        if _MODEL_LOADER.search(str(graph[nid].get("class_type", ""))):
            return nid
        ref = _inputs(graph, nid).get("model")
    return None


def _consumers(graph: Graph, ref: list[Any] | None) -> list[dict[str, Any]]:
    if not ref:
        return []
    return [
        {"node": nid, "title": _title(graph, nid)}
        for nid in graph
        if any(v == [str(ref[0]), int(ref[1])] for v in _inputs(graph, nid).values())
    ]


def discover(graph: Graph) -> dict[str, Any]:
    """What setup proposes for ``graph``: ``slots`` (the best guess, ready to
    save once the user confirms) plus what the setup page shows around them."""
    sampler = base_sampler(graph)
    slots: dict[str, Any] = {}
    found: dict[str, Any] = {"sampler": None}
    if sampler is not None:
        found["sampler"] = {"node": sampler, "title": _title(graph, sampler)}
        for side in ("positive", "negative"):
            pick = prompt_slot(graph, sampler, side)
            found[side] = pick
            # A runtime-built prompt needs the user's pick.
            if pick and not pick["replaces_link"]:
                slots[side] = pick["path"]
        latent = _latent(graph, sampler)
        for key in ("width", "height", "batch_size"):
            path = _literal_path(graph, latent, key, int)
            if path:
                slots[key] = path
        if latent is not None and slots.get("batch_size"):
            slots["per_request"] = _inputs(graph, latent)["batch_size"]
        for key in SAMPLING:
            kind = (int, float) if key == "cfg" else int if key == "steps" else str
            path = _literal_path(graph, sampler, _SAMPLING_INPUTS[key], kind)
            if path:
                slots[key] = path
        loader = model_loader(graph, sampler)
        if loader is not None:
            model, clip = lora_insertion(graph, loader)
            slots["lora_model"] = model
            slots["lora_clip"] = clip
            found["lora"] = {
                "loader": {"node": loader, "title": _title(graph, loader)},
                "model": {"ref": model, "title": _title(graph, str(model[0]))},
                "clip": {"ref": clip, "title": _title(graph, str(clip[0]))}
                if clip
                else None,
                "existing": [
                    {
                        "name": n["inputs"].get("lora_name"),
                        "strength": n["inputs"].get("strength_model"),
                    }
                    for n in graph.values()
                    if n.get("class_type") in ("LoraLoader", "LoraLoaderModelOnly")
                    and isinstance(n["inputs"].get("lora_name"), str)
                ],
                "consumers": _consumers(graph, model),
            }
    seeds = seed_groups(graph)
    slots["seeds"] = [e["path"] for g in seeds for e in g["inputs"]]
    return {
        "slots": slots,
        "found": found,
        "text_inputs": text_inputs(graph, sampler),
        "seeds": seeds,
        "outputs": outputs(graph),
        "input_images": [
            {
                "node": nid,
                "title": _title(graph, nid),
                "image": _inputs(graph, nid).get("image"),
            }
            for nid in graph
            if "loadimage" in str(graph[nid].get("class_type", "")).lower()
        ],
    }


def outputs(graph: Graph) -> list[dict[str, Any]]:
    """Image outputs: SaveImage writes into ComfyUI's output folder (the
    library); a preview is temporary and never reaches it."""
    out = []
    for nid, node in graph.items():
        ct = str(node.get("class_type", ""))
        if ct not in ("SaveImage", "PreviewImage"):
            continue
        prefix = _inputs(graph, nid).get("filename_prefix")
        if _is_link(prefix):
            prefix = gen_metadata._resolve_text(graph, prefix)
        out.append(
            {
                "node": nid,
                "title": _title(graph, nid),
                "saves": ct == "SaveImage",
                "prefix": prefix if isinstance(prefix, str) else None,
            }
        )
    return out


def check_slots(graph: Graph, slots: dict[str, Any]) -> list[str]:
    """What stops these slots from being saved (empty: they can be). Each path
    must point at an input of a node in the graph; a prompt path may replace a
    link only when the slot says so."""
    problems = []
    replaces = set(slots.get("replace_links") or [])
    for key in ("positive", "negative"):
        path = slots.get(key)
        if not path:
            problems.append(f"Choose the {key} prompt's node")
            continue
        value = _inputs(graph, str(path[0])).get(path[1], ...)
        if value is ...:
            problems.append(f"The {key} prompt's node isn't in this workflow")
        elif _is_link(value) and key not in replaces:
            problems.append(f"The {key} prompt's input is a link")
    if slots.get("positive") and slots.get("positive") == slots.get("negative"):
        problems.append("Positive and negative can't be the same input")
    for key in ("width", "height", "batch_size", *SAMPLING):
        path = slots.get(key)
        if path and not _literal_input(graph, path):
            problems.append(
                f"{key.replace('_', ' ').capitalize()} isn't a value in this workflow"
            )
    for path in slots.get("seeds") or []:
        if not _literal_input(graph, path):
            problems.append(f"Seed input {path[0]}.{path[1]} isn't a value")
    for key in ("lora_model", "lora_clip"):
        ref = slots.get(key)
        if ref and str(ref[0]) not in graph:
            problems.append("The LoRA insertion point isn't in this workflow")
    if not has_save_image(graph):
        problems.append("Add a Save Image node: previews never reach the library")
    return problems


def _literal_input(graph: Graph, path: list[Any]) -> bool:
    value = _inputs(graph, str(path[0])).get(path[1], ...)
    return value is not ... and not _is_link(value)
