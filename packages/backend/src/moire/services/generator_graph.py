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
- ``batch_size``: path or None (None: the count is in runs, see
  :func:`split_requests`); ``per_request`` the images each request makes
  (a custom Generator's, 1 when missing; the built-in's is a setting)
- ``sampler`` / ``scheduler`` / ``steps`` / ``cfg``: path or None
- ``checkpoint``: path or None
- ``lora_model`` / ``lora_clip``: ``[node_id, out_index]`` where Moiré's LoRA
  chain starts (the "Model from" / "CLIP from" picks). ``lora_clip`` None
  means a model-only chain (``LoraLoaderModelOnly``).
- ``lora_text``: True when the graph takes LoRAs as ``<lora:name:strength>``
  in the positive prompt instead (a remote workflow whose model Moiré can't
  reach, read by a prompt-parsing encoder such as Impact's
  ``ImpactWildcardEncode``). Only used without ``lora_model``.
"""

from __future__ import annotations

import copy
import random
from dataclasses import dataclass
from typing import Any

from .generation_limits import SEED_MAX
from .model_names import model_stem

Graph = dict[str, dict[str, Any]]

LORA_LOADER = "LoraLoader"
LORA_LOADER_MODEL_ONLY = "LoraLoaderModelOnly"
STOCK_LORA_LOADERS = (LORA_LOADER, LORA_LOADER_MODEL_ONLY)


class GraphError(ValueError):
    """The graph doesn't fit the slots (missing node, slot points at a link)."""


@dataclass(frozen=True)
class LoraPick:
    name: str  # ComfyUI's lora_name value (folder + file)
    strength: float


def is_link(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str)


def node_inputs(graph: Graph, node_id: Any) -> dict[str, Any]:
    """A node's inputs, always a dict (empty for a missing node or null inputs)."""
    node = graph.get(str(node_id))
    inp = node.get("inputs") if isinstance(node, dict) else None
    return inp if isinstance(inp, dict) else {}


def upstream(graph: Graph, start: Any) -> set[str]:
    """Every node a link (or node id) depends on, itself included."""
    todo = [str(start[0]) if is_link(start) else str(start)]
    seen: set[str] = set()
    while todo:
        nid = todo.pop()
        if nid in seen or nid not in graph:
            continue
        seen.add(nid)
        todo.extend(str(v[0]) for v in node_inputs(graph, nid).values() if is_link(v))
    return seen


def node_title(graph: Graph, node_id: str) -> str:
    node = graph.get(node_id) or {}
    meta = node.get("_meta")
    title = meta.get("title") if isinstance(meta, dict) else None
    return str(title or node.get("class_type") or node_id)


def stock_lora_nodes(graph: Graph) -> list[tuple[str, dict[str, Any]]]:
    """The graph's stock LoRA loader nodes, as (node id, node)."""
    return [
        (nid, n)
        for nid, n in graph.items()
        if n.get("class_type") in STOCK_LORA_LOADERS
    ]


def _write(
    graph: Graph, path: list[Any] | None, value: Any, *, over_link: bool = False
) -> None:
    if not path:
        return
    node_id, name = str(path[0]), path[1]
    node = graph.get(node_id)
    if node is None:
        raise GraphError(f"node {node_id} not in graph")
    if not over_link and is_link(node["inputs"].get(name)):
        raise GraphError(f"node {node_id} input {name} is a link, not a value")
    node["inputs"][name] = value


#: Sampler settings a Generator may expose as slots; left out, the graph's own stay.
SAMPLING = ("sampler", "scheduler", "steps", "cfg")

#: The input each sampling slot maps to on a KSampler-like node.
SAMPLING_INPUTS = {
    "sampler": "sampler_name",
    "scheduler": "scheduler",
    "steps": "steps",
    "cfg": "cfg",
}


def slot_value(graph: Graph, path: Any) -> Any:
    """The graph's own value at slot ``[node, input]``; None for a link or
    nothing there."""
    if not path:
        return None
    value = ((graph.get(str(path[0])) or {}).get("inputs") or {}).get(path[1])
    return None if is_link(value) else value


def sampling_defaults(graph: Graph, slots: dict[str, Any]) -> dict[str, Any]:
    """What the graph has at each sampling slot it exposes."""
    out = {}
    for key in SAMPLING:
        value = slot_value(graph, slots.get(key))
        if value is not None:
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
        stem = model_stem(lo["name"])
        if stem in seen:
            continue
        seen.add(stem)
        out.append(LoraPick(lo["name"], float(lo.get("strength", 1.0))))
    return out


def lora_tags(loras: list[LoraPick]) -> str:
    """``<lora:name:strength>`` for each pick, space separated (A1111 syntax,
    ComfyUI's lora_name as the name)."""
    return " ".join(f"<lora:{p.name}:{_plain(p.strength)}>" for p in loras)


def _plain(x: float) -> str:
    """A strength as plain decimals (``0.8``, ``1``): never ``1e-05``, which
    the ``<lora:...>`` parsers can't read."""
    return f"{x:.4f}".rstrip("0").rstrip(".") or "0"


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
        for nid, node in stock_lora_nodes(graph):
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
        model_stem(n["inputs"]["lora_name"]): n
        for _, n in stock_lora_nodes(graph)
        if isinstance(n["inputs"].get("lora_name"), str)
    }
    to_add: list[LoraPick] = []
    for pick in loras:
        node = existing.get(model_stem(pick.name))
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
            if not is_link(value) or nid in chain:
                continue
            if value == model_from:
                node["inputs"][name] = list(model)
            elif clip is not None and value == clip_from:
                node["inputs"][name] = list(clip)
    return graph


def drop_missing(graph: Graph, missing: set[str]) -> list[str]:
    """Take out nodes whose class ComfyUI doesn't have, where no image
    output needs them (a display or a prompt join Moiré replaced), and the
    nodes reading from them that no output needs either. ComfyUI refuses a
    graph with any unknown class, used or not. Returns the missing classes an
    output does need (left in: ComfyUI's error names them). Mutates."""
    needed: set[str] = set()
    for nid, n in graph.items():
        if is_save_image(n.get("class_type")):
            needed |= upstream(graph, nid)
    gone = {
        nid
        for nid, n in graph.items()
        if n.get("class_type") in missing and nid not in needed
    }
    while True:
        more = {
            nid
            for nid, n in graph.items()
            if nid not in gone
            and nid not in needed
            and any(
                is_link(v) and str(v[0]) in gone
                for v in node_inputs(graph, nid).values()
            )
        }
        if not more:
            break
        gone |= more
    for nid in gone:
        del graph[nid]
    return sorted(
        {
            graph[n]["class_type"]
            for n in needed
            if graph[n].get("class_type") in missing
        }
    )


def bypass_loras(
    graph: Graph, node_ids: list[str], refs: list[list[Any] | None] = ()
) -> list[list[Any] | None]:
    """Leave out stock LoRA loaders (one the connected ComfyUI doesn't have):
    whatever read a loader's model / CLIP reads what fed it. ``refs`` (the
    LoRA insertion point) are moved the same way and returned. Mutates."""
    refs = [list(r) if r else None for r in refs]
    for nid in node_ids:
        node = graph.get(str(nid))
        if node is None or node.get("class_type") not in STOCK_LORA_LOADERS:
            continue
        nid = str(nid)
        inp = node_inputs(graph, nid)
        feeds = {0: inp.get("model"), 1: inp.get("clip")}
        del graph[nid]

        def moved(v: Any) -> Any:
            if is_link(v) and str(v[0]) == nid and feeds.get(int(v[1])) is not None:
                return list(feeds[int(v[1])])
            return v

        for oid in graph:
            inputs = node_inputs(graph, oid)
            for name, v in list(inputs.items()):
                inputs[name] = moved(v)
        refs = [moved(r) if r else None for r in refs]
    return refs


# Text display nodes whose string inputs are only the editor's cache of what
# they showed last run (pysssss Show Text and kin). Named, not guessed: other
# "preview" / "show" nodes keep state in string widgets (a mask-edited file).
_DISPLAY_TEXT = {
    "showtext",
    "showtext|pysssss",
    "displaytext",
    "previewany",
    "showanything",
}


def clear_display_text(graph: Graph) -> Graph:
    """Empty the text display nodes' cached text from the last editor run:
    it would travel with every prompt and is shown again once this run ends
    anyway. Mutates."""
    for node in graph.values():
        if str(node.get("class_type", "")).lower().replace(" ", "") in _DISPLAY_TEXT:
            for name, v in node.get("inputs", {}).items():
                if isinstance(v, str):
                    node["inputs"][name] = ""
    return graph


def family_pnginfo(source: dict[str, Any] | None) -> dict[str, Any] | None:
    """What a prompt adds to its images so they join the family they were set
    up from: a ``moire`` chunk with the family id (the scanner reads it when
    the image has no editor workflow). Not an editor workflow: ComfyUI loads
    that ahead of the prompt, so a partial one would break reopening the
    image there. None for an upload or an image without a family."""
    family = (source or {}).get("family")
    return {"moire": {"family": family}} if family else None


_WIDGET_DEFAULTS = {"INT": 0, "FLOAT": 0.0, "STRING": "", "BOOLEAN": False}


def _widget_default(spec: Any) -> Any:
    """What ComfyUI's editor would put in a widget input it finds missing:
    the input's default, else a combo's first choice. None for a link input
    (MODEL, IMAGE, ...)."""
    if not isinstance(spec, (list, tuple)) or not spec:
        return None
    kind, opts = spec[0], spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if opts.get("forceInput"):
        return None  # a link-only input: missing is ComfyUI's error to report
    if isinstance(kind, list):  # an old-style combo: the choices themselves
        return opts.get("default", kind[0] if kind else None)
    if kind == "COMBO":
        choices = opts.get("options") or []
        return opts.get("default", choices[0] if choices else None)
    if kind in _WIDGET_DEFAULTS:
        return opts.get("default", opts.get("min", _WIDGET_DEFAULTS[kind]))
    return None


def fill_defaults(graph: Graph, info: dict[str, Any]) -> list[list[str]]:
    """Give required widget inputs a graph doesn't have their default, as
    ComfyUI's editor does when it loads an older workflow (a node that gained
    an input since). ``info``: ComfyUI's ``/object_info``. Returns the
    ``[node, input]`` filled. Mutates."""
    filled = []
    for nid, node in graph.items():
        spec = (info.get(node.get("class_type")) or {}).get("input") or {}
        for name, s in (spec.get("required") or {}).items():
            if name in node.get("inputs", {}):
                continue
            value = _widget_default(s)
            if value is not None:
                node.setdefault("inputs", {})[name] = value
                filled.append([nid, name])
    return filled


def build_prompt(graph: Graph, slots: dict[str, Any], values: dict[str, Any]) -> Graph:
    """The graph for one request. ``values``: positive, negative, seed, and
    optionally width, height, batch_size, checkpoint, sampler, scheduler,
    steps, cfg, loras (list of
    :class:`LoraPick`, already merged by precedence; with ``lora_text`` they
    go into the positive prompt as tags). Never mutates ``graph``."""
    g = copy.deepcopy(graph)
    loras = values.get("loras") or []
    positive = values["positive"]
    if loras and not slots.get("lora_model") and slots.get("lora_text"):
        positive = ", ".join(
            x for x in (positive.rstrip(", \n"), lora_tags(loras)) if x
        )
        loras = []
    # A prompt built at run time (a join) is replaced only when setup said so.
    over = set(slots.get("replace_links") or [])
    _write(g, slots.get("positive"), positive, over_link="positive" in over)
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
    model_from, clip_from = slots.get("lora_model"), slots.get("lora_clip")
    if slots.get("drop_loras"):
        model_from, clip_from = bypass_loras(
            g, slots["drop_loras"], [model_from, clip_from]
        )
    if loras:
        if not model_from:
            raise GraphError("this workflow has no LoRA insertion point")
        splice_loras(g, model_from, clip_from, loras)
    return g


def split_requests(count: int, per_request: int | None) -> list[int | None]:
    """Images asked of each request. With a known images-per-request, 8 at 2
    is ``[2, 2, 2, 2]`` and the last one is smaller if uneven. With none
    (batch_size not mapped), ``count`` is a number of runs, each of
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


def is_save_image(class_type: object) -> bool:
    """A node that writes images into ComfyUI's output folder: stock SaveImage
    and the custom savers named like it ("Save Image w/o Metadata", "Image
    Save"); previews are temporary and don't count."""
    ct = str(class_type or "").lower().replace(" ", "")
    return "preview" not in ct and ("saveimage" in ct or "imagesave" in ct)


def has_save_image(graph: Graph) -> bool:
    return any(is_save_image(n.get("class_type")) for n in graph.values())
