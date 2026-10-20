"""Pure functions over ComfyUI API-format graphs: no I/O, no database.

A graph is ``{node_id: {"class_type": str, "inputs": {name: value | [src_id,
out_index]}}}``. A Generator pairs a graph with *slots*: where Moiré writes
each per-request value. A slot path is ``[node_id, input_name]`` and must point
at a literal input (not a link).

Slots (found for a custom graph by :mod:`services.generator_discovery`):

- ``positive`` / ``negative``: path (required); ``replace_links`` lists the
  ones whose path is a link Moiré overwrites (a prompt joined at run time)
- ``seeds``: list of paths, all set to the request's seed
- ``width`` / ``height``: path or None
- ``batch_size``: path or None (None: the count is in requests, see
  :func:`split_requests`); ``per_request`` the images each request makes
  (a custom Generator's; the built-in's is a setting)
- ``sampler`` / ``scheduler`` / ``steps`` / ``cfg``: path or None
- ``checkpoint``: path or None
- ``lora_model`` / ``lora_clip``: ``[node_id, out_index]`` where Moiré's LoRA
  chain starts (the "Model from" / "CLIP from" picks). ``lora_clip`` None
  means a model-only chain (``LoraLoaderModelOnly``).
"""

from __future__ import annotations

import copy
import random
from dataclasses import dataclass
from typing import Any

Graph = dict[str, dict[str, Any]]

LORA_LOADER = "LoraLoader"
LORA_LOADER_MODEL_ONLY = "LoraLoaderModelOnly"
_STOCK_LORA_LOADERS = (LORA_LOADER, LORA_LOADER_MODEL_ONLY)

# ComfyUI's seed widgets take an unsigned 64-bit value; stay well inside it.
SEED_MAX = 2**50


class GraphError(ValueError):
    """The graph doesn't fit the slots (missing node, slot points at a link)."""


@dataclass(frozen=True)
class LoraPick:
    name: str  # ComfyUI's lora_name value (folder + file)
    strength: float


def lora_stem(name: str) -> str:
    """``"styles/flat_color_xl.safetensors"`` -> ``"flat_color_xl"``: no folder,
    no extension. The key that matches ``image_loras.name``."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    if "." in base:
        stem, ext = base.rsplit(".", 1)
        # Only drop a real file extension, so "v1.5_style" keeps its dot.
        if ext.lower() in ("safetensors", "ckpt", "pt", "pth", "bin"):
            return stem
    return base


def _is_link(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str)


def _write(
    graph: Graph, path: list[Any] | None, value: Any, *, over_link: bool = False
) -> None:
    if not path:
        return
    node_id, name = str(path[0]), path[1]
    node = graph.get(node_id)
    if node is None:
        raise GraphError(f"node {node_id} not in graph")
    if not over_link and _is_link(node["inputs"].get(name)):
        raise GraphError(f"node {node_id} input {name} is a link, not a value")
    node["inputs"][name] = value


#: Sampler settings a Generator may expose as slots; left out, the graph's own stay.
SAMPLING = ("sampler", "scheduler", "steps", "cfg")


def sampling_defaults(graph: Graph, slots: dict[str, Any]) -> dict[str, Any]:
    """What the graph has at each sampling slot it exposes."""
    out = {}
    for key in SAMPLING:
        path = slots.get(key)
        if path:
            value = (graph.get(str(path[0])) or {}).get("inputs", {}).get(path[1])
            if value is not None and not _is_link(value):
                out[key] = value
    return out


def _next_ids(graph: Graph):
    nums = [int(k) for k in graph if k.isdigit()]
    n = max(nums, default=0)
    while True:
        n += 1
        if str(n) not in graph:
            yield str(n)


def merge_loras(
    characters: list[dict[str, Any] | None],
    style: list[dict[str, Any]] | None,
) -> list[LoraPick]:
    """The characters' LoRAs in order, then the style LoRAs, each file once
    (by stem, so two spellings of one file can't both get in): a character's
    strength wins over a style pick of the same LoRA. Pure."""
    out: list[LoraPick] = []
    seen: set[str] = set()
    for lo in [c for c in characters if c] + list(style or []):
        stem = lora_stem(lo["name"])
        if stem in seen:
            continue
        seen.add(stem)
        out.append(LoraPick(lo["name"], float(lo.get("strength", 1.0))))
    return out


def lora_insertion(graph: Graph, loader_id: str) -> tuple[list[Any], list[Any] | None]:
    """Default "Model from" / "CLIP from" picks for a model loader: walk past
    the stock LoRA loaders already chained after it, so Moiré's chain goes in
    after the Generator's own. Returns ``([node, out], [node, out] | None)``.
    """
    loader = graph.get(loader_id)
    if loader is None:
        raise GraphError(f"node {loader_id} not in graph")
    model: list[Any] = [loader_id, 0]
    clip: list[Any] | None = (
        [loader_id, 1] if loader["class_type"] == "CheckpointLoaderSimple" else None
    )
    while True:
        nxt = None
        for nid, node in graph.items():
            if node["class_type"] not in _STOCK_LORA_LOADERS:
                continue
            if node["inputs"].get("model") != model:
                continue
            if node["class_type"] == LORA_LOADER and node["inputs"].get("clip") != clip:
                continue
            nxt = nid
            break
        if nxt is None:
            return model, clip
        model = [nxt, 0]
        if graph[nxt]["class_type"] == LORA_LOADER:
            clip = [nxt, 1]


def splice_loras(
    graph: Graph,
    model_from: list[Any],
    clip_from: list[Any] | None,
    loras: list[LoraPick],
) -> Graph:
    """Insert a LoRA chain after ``model_from`` / ``clip_from`` and point every
    consumer of those outputs at the chain's end, so hires passes and detailers
    get the LoRAs too. A LoRA the graph already loads through a stock loader
    keeps its node and gets the new strength instead. Mutates and returns
    ``graph``."""
    model_from = [str(model_from[0]), int(model_from[1])]
    clip_from = [str(clip_from[0]), int(clip_from[1])] if clip_from else None
    for ref in (model_from, clip_from):
        if ref and ref[0] not in graph:
            raise GraphError(f"node {ref[0]} not in graph")

    existing = {
        lora_stem(n["inputs"].get("lora_name", "")): n
        for n in graph.values()
        if n["class_type"] in _STOCK_LORA_LOADERS
        and isinstance(n["inputs"].get("lora_name"), str)
    }
    to_add: list[LoraPick] = []
    for pick in loras:
        node = existing.get(lora_stem(pick.name))
        if node is None:
            to_add.append(pick)
            continue
        node["inputs"]["strength_model"] = pick.strength
        if node["class_type"] == LORA_LOADER:
            node["inputs"]["strength_clip"] = pick.strength
    if not to_add:
        return graph

    ids = _next_ids(graph)
    chain: list[str] = []
    model, clip = model_from, clip_from
    for pick in to_add:
        nid = next(ids)
        if clip is None:
            graph[nid] = {
                "class_type": LORA_LOADER_MODEL_ONLY,
                "inputs": {
                    "lora_name": pick.name,
                    "strength_model": pick.strength,
                    "model": model,
                },
            }
        else:
            graph[nid] = {
                "class_type": LORA_LOADER,
                "inputs": {
                    "lora_name": pick.name,
                    "strength_model": pick.strength,
                    "strength_clip": pick.strength,
                    "model": model,
                    "clip": clip,
                },
            }
            clip = [nid, 1]
        model = [nid, 0]
        chain.append(nid)

    first = chain[0]
    for nid, node in graph.items():
        if nid == first:
            continue
        for name, value in node["inputs"].items():
            if not _is_link(value) or nid in chain:
                continue
            if value == model_from:
                node["inputs"][name] = list(model)
            elif clip is not None and value == clip_from:
                node["inputs"][name] = list(clip)
    return graph


def build_prompt(graph: Graph, slots: dict[str, Any], values: dict[str, Any]) -> Graph:
    """The graph for one request. ``values``: positive, negative, seed, and
    optionally width, height, batch_size, checkpoint, sampler, scheduler,
    steps, cfg, loras (list of
    :class:`LoraPick`, already merged by precedence). Never mutates ``graph``."""
    g = copy.deepcopy(graph)
    # A prompt built at run time (a join) is replaced only when setup said so.
    over = set(slots.get("replace_links") or [])
    _write(g, slots.get("positive"), values["positive"], over_link="positive" in over)
    _write(
        g,
        slots.get("negative"),
        values.get("negative", ""),
        over_link="negative" in over,
    )
    for path in slots.get("seeds") or []:
        _write(g, path, values["seed"])
    for key in ("width", "height", "checkpoint", *SAMPLING):
        if values.get(key) is not None:
            _write(g, slots.get(key), values[key])
    if values.get("batch_size") is not None and slots.get("batch_size"):
        _write(g, slots["batch_size"], values["batch_size"])
    loras = values.get("loras") or []
    if loras:
        if not slots.get("lora_model"):
            raise GraphError("this workflow has no LoRA insertion point")
        splice_loras(g, slots["lora_model"], slots.get("lora_clip"), loras)
    return g


def split_requests(count: int, per_request: int | None) -> list[int | None]:
    """Images asked of each request. With a known images-per-request, 8 at 2
    is ``[2, 2, 2, 2]`` and the last one is smaller if uneven. With none
    (batch_size not mapped), ``count`` is a number of requests, each of
    unknown size."""
    if count < 1:
        return []
    if not per_request or per_request < 1:
        return [None] * count
    full, rest = divmod(count, per_request)
    sizes: list[int | None] = [per_request] * full
    return sizes + ([rest] if rest else [])


def seeds_for(
    n: int, *, fixed: int | None = None, rng: random.Random | None = None
) -> list[int]:
    """One seed per request. Fixed: the given seed, then counting up. Random:
    independent draws."""
    if fixed is not None:
        return [(fixed + i) % SEED_MAX for i in range(n)]
    r = rng or random.SystemRandom()
    return [r.randrange(SEED_MAX) for _ in range(n)]


def has_save_image(graph: Graph) -> bool:
    return any(n.get("class_type") == "SaveImage" for n in graph.values())
