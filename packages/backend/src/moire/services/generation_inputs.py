"""A queue body -> the inputs a batch keeps: the work shape, the characters,
the prompt parts (:func:`build_batch_inputs`), and the keys "Queue again"
replays from them (:data:`REPLAY_KEYS`). Pure."""

from __future__ import annotations

import json
from typing import Any, NamedTuple

from .generation_compose import compose, compose_parts, prompt_terms
from .generation_limits import MAX_CHARACTERS, clamp_per_request
from .generator_graph import SAMPLING, seeds_for, split_requests
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
        clamp_per_request(int(body["per_request"]))
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


class BatchPlan(NamedTuple):
    """What :func:`build_batch_inputs` makes of a queue body: the inputs the
    batch keeps, each request's image count and seed, and the words its auto
    name is built from."""

    inputs: dict[str, Any]
    sizes: list[int | None]
    seeds: list[int]
    name_words: list[str]


# The keys of a batch's inputs that "Queue again" sends back as the body.
REPLAY_KEYS = (
    "base",
    "extra",
    "negative_base",
    "negative_extra",
    "checkpoint",
    "sampling",
    "loras",
    "character",
    "characters",
    "positive",
    "negative",
    "composer",
    "width",
    "height",
    "count",
    "seed",
)
# The other keys: made again from the replayed ones (the prompt text, the
# images per request), or not replayed at all (a test run requeued is a
# plain batch). ``per_request_asked`` is replayed as the body's
# ``per_request``, so only a size the user chose comes back.
DERIVED_KEYS = (
    "positive_text",
    "negative_text",
    "per_request",
    "per_request_asked",
    "test",
)


def replay_body(inputs: dict[str, Any]) -> dict[str, Any]:
    """A queue body that makes a batch with these inputs again (new seeds
    unless they were fixed; today's images-per-request setting unless the
    user chose one)."""
    return {
        **{k: inputs.get(k) for k in REPLAY_KEYS},
        "per_request": inputs.get("per_request_asked"),
    }


def build_batch_inputs(
    body: dict[str, Any],
    gen: dict[str, Any],
    settings: dict[str, Any],
    *,
    test: bool = False,
) -> BatchPlan:
    """The batch a queue body asks for, as it is kept: every key of its
    ``inputs`` is in :data:`REPLAY_KEYS` or :data:`DERIVED_KEYS`. Pure but
    for random seeds."""
    shape = batch_shape(gen, body, settings)
    count = shape["count"]
    sizes = split_requests(count, shape["per_request"])
    seed = body.get("seed") or {}
    fixed = (
        int(seed["value"])
        if seed.get("mode") == "fixed" and seed.get("value") is not None
        else None
    )
    seeds = seeds_for(len(sizes), fixed=fixed)

    extra = list(body.get("extra") or [])
    characters = _characters_input(body)
    inputs: dict[str, Any] = {
        "base": body.get("base") or "",
        "extra": extra,
        "negative_base": body.get("negative_base") or "",
        "negative_extra": list(body.get("negative_extra") or []),
        "checkpoint": shape["checkpoint"],
        "sampling": shape["sampling"],
        "loras": [
            {"name": lo["name"], "strength": float(lo.get("strength", 1.0))}
            for lo in body.get("loras") or []
        ],
        "characters": characters,
        # The first, for readers of batches from before several.
        "character": characters[0] if characters else None,
        "width": shape["width"],
        "height": shape["height"],
        "seed": {
            "mode": "fixed" if fixed is not None else "random",
            "value": fixed,
        },
        "count": count,
        "per_request": shape["per_request"],
        # What the user set, apart from the setting it resolved to.
        "per_request_asked": shape["per_request_asked"],
        "test": test,
    }
    positive = _parts(body.get("positive"))
    if positive is not None:
        # The layered composer: ordered parts, and its own state for
        # "Edit and queue" (opaque here).
        negative = _parts(body.get("negative")) or []
        inputs["positive"] = positive
        inputs["negative"] = negative
        composer = body.get("composer")
        inputs["composer"] = (
            composer
            if isinstance(composer, dict) and len(json.dumps(composer)) < 50_000
            else None
        )
        inputs["positive_text"] = compose_parts(_resolve(positive, characters))
        inputs["negative_text"] = compose_parts(_resolve(negative, []))
        name_words = prompt_terms(
            " , ".join(p["text"] for p in positive if p.get("role") == "prompt")
        )
    else:
        # Batches from before the layered composer (and the test run).
        inputs["positive_text"] = compose(
            inputs["base"],
            [w for c in characters for w in [*c["tags"], *outfit_tags(c)]],
            extra,
        )
        inputs["negative_text"] = compose(
            inputs["negative_base"], inputs["negative_extra"]
        )
        name_words = extra
    return BatchPlan(inputs, sizes, seeds, name_words)
