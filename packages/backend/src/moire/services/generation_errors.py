"""The errors queueing a generation batch can raise, and the annotation that
points ComfyUI's node errors at the composer control they came from."""

from __future__ import annotations

from typing import Any

from .generator_graph import SAMPLING, STOCK_LORA_LOADERS


class Unavailable(Exception):
    """ComfyUI isn't configured or reachable; nothing was queued."""


class Invalid(Exception):
    """The request can't be queued as asked (bad generator, no output folder)."""


class Rejected(Exception):
    """ComfyUI rejected the first request; nothing was kept."""

    def __init__(self, message: str, node_errors: list[dict[str, Any]]):
        super().__init__(message)
        self.message = message
        self.node_errors = node_errors


def annotate_node_errors(
    errors: list[dict[str, Any]], gen: dict[str, Any], graph: dict[str, Any]
) -> list[dict[str, Any]]:
    """Add ``field`` (checkpoint / lora / positive / negative) to each node
    error, so the composer can flag the control it came from. A LoRA loader
    the Generator's own graph doesn't have was added by Moiré (``added``)."""
    slots = gen.get("slots") or {}

    def slot_node(key: str) -> str | None:
        path = slots.get(key)
        return str(path[0]) if path else None

    def at_slot(key: str, node: str, err: dict[str, Any]) -> bool:
        # The sampler node has other inputs (seed, model, latent): match the input too.
        path = slots.get(key)
        return bool(path) and node == str(path[0]) and err.get("input") == path[1]

    out = []
    for err in errors:
        node = str(err.get("node") or "")
        extra: dict[str, Any] = {"field": None}
        cls = (graph.get(node) or {}).get("class_type")
        if node and node == slot_node("checkpoint"):
            extra["field"] = "checkpoint"
        elif node and any(at_slot(k, node, err) for k in SAMPLING):
            extra["field"] = "sampling"
        elif cls in STOCK_LORA_LOADERS:
            extra = {
                "field": "lora",
                "lora_name": graph[node]["inputs"].get("lora_name"),
                "added": node not in (gen.get("graph") or {}),
            }
        elif node and node == slot_node("positive"):
            extra["field"] = "positive"
        elif node and node == slot_node("negative"):
            extra["field"] = "negative"
        out.append({**err, **extra})
    return out
