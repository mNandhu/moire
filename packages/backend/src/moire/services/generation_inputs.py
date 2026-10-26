"""A queue body -> the inputs a batch keeps: the work shape, the characters,
the prompt parts. Pure."""

from __future__ import annotations

from typing import Any

from .generator_graph import SAMPLING
from .outfits import clean_tags


def batch_shape(
    gen: dict[str, Any], body: dict[str, Any], settings: dict[str, Any]
) -> dict[str, Any]:
    """The parts of a batch's inputs that decide how much work it is, as
    queue_batch keeps them (the run-time estimate reads the same):

    - ``count``, clamped;
    - ``per_request``: images per request, the body's choice, else the
      setting (built-in) or the Generator's (1 if it has none); ``None`` when
      the Generator has no batch size (count is then in runs);
    - ``per_request_asked``: what the body chose, apart from the setting;
    - ``checkpoint``, ``sampling`` (only slots the Generator has), ``width``,
      ``height``."""
    has_batch = bool(gen["slots"].get("batch_size"))
    builtin = gen["kind"] == "builtin"
    asked = (
        max(1, min(64, int(body["per_request"])))
        if has_batch and body.get("per_request")
        else None
    )
    if not has_batch:
        per_request = None
    elif asked:
        per_request = asked
    elif builtin:
        per_request = int(settings.get("builtin_per_request") or 1)
    else:
        # Mapped with no size saved: 1, as Generate and setup show it, so
        # the count stays in images.
        per_request = int(gen["slots"].get("per_request") or 1)
    return {
        "count": max(1, min(500, int(body.get("count") or 1))),
        "per_request": per_request,
        "per_request_asked": asked,
        # Only where the graph lets Moiré set it (a custom one keeps its own).
        "checkpoint": (body.get("checkpoint") or None)
        if gen["slots"].get("checkpoint")
        else None,
        "sampling": _sampling_input(body.get("sampling"), gen["slots"]),
        "width": body.get("width"),
        "height": body.get("height"),
    }


_PART_KINDS = ("text", "character", "embedding")


def _parts(raw: Any) -> list[dict[str, Any]] | None:
    """The composer's ordered prompt parts: text (``role`` says which layer:
    prefix, prompt, text, preset), the character's tags, an embedding.
    ``None`` when the body has none (an old-style batch)."""
    if not isinstance(raw, list):
        return None
    out = []
    for p in raw[:64]:
        if not isinstance(p, dict) or p.get("kind") not in _PART_KINDS:
            continue
        out.append(
            {
                "kind": p["kind"],
                "role": str(p.get("role") or "")[:20],
                "label": str(p.get("label") or "")[:120],
                "text": str(p.get("text") or "")[:8000],
                "name": str(p.get("name") or "")[:400],
            }
        )
    return out


def _resolve(
    parts: list[dict[str, Any]], characters: list[dict[str, Any]]
) -> list[str | list[str]]:
    """Parts as :func:`compose_parts` items: text raw, each character's tags
    as its own chip block, in order (nothing when none is picked), embeddings
    as words."""
    items: list[str | list[str]] = []
    for p in parts:
        if p["kind"] == "text":
            items.append(p["text"])
        elif p["kind"] == "character":
            for c in characters:
                items.append(c["tags"])
                items.append(outfit_tags(c))
        elif p["name"]:
            items.append(f"embedding:{p['name']}")
    return items


MAX_CHARACTERS = 8


def outfit_tags(c: dict[str, Any]) -> list[str]:
    """The tags a character's recorded outfit sent (none without one). Pure."""
    o = c.get("outfit")
    return list(o.get("tags") or []) if isinstance(o, dict) else []


def characters_of(holder: dict[str, Any]) -> list[dict[str, Any]]:
    """The characters of a queue body or a batch's inputs: ``characters``, or
    the single ``character`` older batches have. Pure."""
    many = holder.get("characters")
    if isinstance(many, list):
        return [c for c in many if isinstance(c, dict)]
    one = holder.get("character")
    return [one] if isinstance(one, dict) else []


def _characters_input(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The body's characters as the batch keeps them, each tag once."""
    out: list[dict[str, Any]] = []
    for raw in characters_of(body)[:MAX_CHARACTERS]:
        c = _character_input(raw)
        if c and all(x["tag"] != c["tag"] for x in out):
            out.append(c)
    return out


def _sampling_input(raw: Any, slots: dict[str, Any]) -> dict[str, Any]:
    """The sampler settings asked for, for the slots this Generator has."""
    if not isinstance(raw, dict):
        return {}
    return {k: raw[k] for k in SAMPLING if raw.get(k) is not None and slots.get(k)}


def _character_input(c: dict[str, Any] | None) -> dict[str, Any] | None:
    """The Character block as the batch keeps it: tag, display label, the tags
    sent, and its LoRA (an installed file name) if any."""
    if not c or not c.get("tag"):
        return None
    lora = c.get("lora")
    return {
        "tag": c["tag"],
        "label": (c.get("label") or "").strip(),
        "tags": [w for w in (c.get("tags") or []) if isinstance(w, str) and w.strip()],
        "lora": {"name": lora["name"], "strength": float(lora.get("strength", 1.0))}
        if lora and lora.get("name")
        else None,
        "outfit": _outfit_input(c.get("outfit")),
    }


def _outfit_input(o: Any) -> dict[str, Any] | None:
    """A character's outfit as the batch keeps it: id, name and the tags sent
    (a snapshot: editing the saved outfit later never changes the batch)."""
    if not isinstance(o, dict) or not o.get("id"):
        return None
    tags = clean_tags(o.get("tags") or [])
    if not tags:
        return None
    return {"id": str(o["id"]), "name": (o.get("name") or "").strip(), "tags": tags}
