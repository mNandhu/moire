"""ComfyUI graph text resolution: the text a link in an API-format graph
carries, walking upstream from a text-encode through primitives, concat
nodes and display nodes, plus the checkpoint name behind a ``model`` link.

Pure (no I/O). :mod:`services.text_eval` computes text the graph builds at
run time; this module decides which source wins. Extraction
(:mod:`services.gen_metadata`) and generator discovery both read prompts
through it.
"""

from __future__ import annotations

import re
from typing import Any

from . import text_eval


def _node(prompt_json: dict[str, Any], ref: Any) -> dict[str, Any] | None:
    """Resolve a ComfyUI input link ``[node_id, slot]`` to its node dict."""
    if not isinstance(ref, list) or not ref:
        return None
    node = prompt_json.get(str(ref[0]))
    return node if isinstance(node, dict) else None


# Prompts are often built at run time (a captioner's output joined to fixed
# text), so the text a sampler saw may not be in the graph at all. Display
# nodes (pysssss ShowText and kin) record the text they showed: in the API
# graph as ``text_0`` and in the editor workflow as the node's widget value,
# written when it ran. But it is written when the prompt is *queued*, so it
# holds the previous run's text: when the text feeding the display can be
# computed from the graph (`text_eval`), that is what ran and wins; the cache
# is the fallback for chains that can't be (captioners, LLMs, wildcards).

_CONCAT_INPUT = re.compile(r"^(?:text|string)_?(?:\d+|[a-z])$")


def is_display(class_type: Any) -> bool:
    ct = str(class_type or "").lower()
    return "show" in ct or "display" in ct or ("preview" in ct and "image" not in ct)


def _display_source(node: Any) -> list | None:
    """The link a display node shows (its first linked input)."""
    inp = node.get("inputs") if isinstance(node, dict) else None
    if not isinstance(inp, dict):
        return None
    return next((v for v in inp.values() if isinstance(v, list) and v), None)


def displayed_text(prompt_json: Any, node_id: Any) -> str | None:
    """The text display node ``node_id`` showed *this* run, computed from the
    graph; ``None`` when that isn't possible (then only its stale cache is
    known)."""
    if not isinstance(prompt_json, dict):
        return None
    node = prompt_json.get(str(node_id))
    if not isinstance(node, dict) or not is_display(node.get("class_type")):
        return None
    src = _display_source(node)
    return text_eval.evaluate(prompt_json, src) if src else None


def display_cache(
    prompt_json: dict[str, Any] | None, workflow_json: Any = None
) -> dict[str, str]:
    """``{source_node_id: text}``: the text a display node showed for the node
    feeding it. Best effort; empty when there are no display nodes."""
    if not isinstance(prompt_json, dict):
        return {}
    shown: dict[str, str] = {}
    widgets: dict[str, str] = {}
    nodes = workflow_json.get("nodes") if isinstance(workflow_json, dict) else None
    for wn in nodes if isinstance(nodes, list) else []:
        if not isinstance(wn, dict) or not is_display(wn.get("type")):
            continue
        wv = wn.get("widgets_values")
        while isinstance(wv, list) and wv:
            wv = wv[0]
        if isinstance(wv, str) and wv.strip():
            widgets[str(wn.get("id"))] = wv
    for node_id, node in prompt_json.items():
        if not isinstance(node, dict) or not is_display(node.get("class_type")):
            continue
        src = _display_source(node)
        if src is None:
            continue
        cached = node["inputs"].get("text_0")
        text = (
            text_eval.evaluate(prompt_json, src)
            or (cached if isinstance(cached, str) and cached.strip() else None)
            or widgets.get(str(node_id))
        )
        if text:
            shown.setdefault(str(src[0]), text)
    return shown


def resolve_text(
    prompt_json: dict[str, Any],
    ref: Any,
    _seen: set[str] | None = None,
    shown: dict[str, str] | None = None,
) -> str | None:
    """Best-effort text a link carries, walking upstream from a text-encode.

    In order: a literal ``text`` widget; the text computed from the graph
    (:mod:`services.text_eval`); text a display node showed for this node
    (:func:`display_cache`); a ``text`` link; SDXL ``text_g`` / ``text_l``;
    a string widget (primitives); a concat node's resolvable inputs joined
    with its delimiter (a partial prompt beats none). Guards against cycles.
    """
    node = _node(prompt_json, ref)
    if node is None:
        return None
    seen = _seen or set()
    key = str(ref[0])
    if key in seen:
        return None
    seen.add(key)
    shown = shown or {}
    inp = node.get("inputs", {})
    if not isinstance(inp, dict):
        return None

    text = inp.get("text")
    if isinstance(text, str):
        return text
    computed = text_eval.evaluate(prompt_json, ref)
    if computed is not None:
        return computed
    if key in shown:
        return shown[key]
    if isinstance(text, list):  # text itself is a link
        return resolve_text(prompt_json, text, seen, shown)

    def value(v: Any) -> str | None:
        if isinstance(v, str):
            return v
        if isinstance(v, list):
            return resolve_text(prompt_json, v, seen, shown)
        return None

    sdxl = [value(inp.get(k)) for k in ("text_g", "text_l")]
    sdxl = [t for t in sdxl if t and t.strip()]
    if sdxl:
        return sdxl[0] if len(set(sdxl)) == 1 else ", ".join(sdxl)
    for k in ("string", "value", "prompt"):
        v = value(inp.get(k))
        if v is not None:
            return v
    parts = [
        value(v)
        for k, v in sorted(inp.items())
        if _CONCAT_INPUT.match(k) and not k.startswith("text_0")
    ]
    parts = [p.strip() for p in parts if p and p.strip()]
    if parts:
        delim = next(
            (
                inp[k]
                for k in ("delimiter", "separator", "join_with")
                if isinstance(inp.get(k), str)
            ),
            ", ",
        )
        return (delim or " ").join(parts)
    return None


def resolve_ckpt(
    prompt_json: dict[str, Any], ref: Any, _seen: set[str] | None = None
) -> str | None:
    """Walk the ``model`` link upstream to a checkpoint loader's name widget."""
    node = _node(prompt_json, ref)
    if node is None:
        return None
    seen = _seen or set()
    key = str(ref[0])
    if key in seen:
        return None
    seen.add(key)

    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        return None
    for name_key in ("ckpt_name", "base_ckpt_name", "model_name", "unet_name"):
        v = inputs.get(name_key)
        if isinstance(v, str) and v:
            return v
    # Keep walking upstream through model-patch nodes (LoRA loaders etc.).
    return resolve_ckpt(prompt_json, inputs.get("model"), seen)
