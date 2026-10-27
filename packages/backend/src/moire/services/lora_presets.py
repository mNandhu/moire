"""Activation presets for style LoRAs: per LoRA (by stem), named sets of the
words it wants in the prompt and a default strength. The composer's Style
layer picks one per LoRA, like Prefix picks a prompt preset. The words it
suggests are :mod:`services.lora_words`.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from ..database import schema as t
from .model_names import model_stem
from .preset_store import PresetError, Store, clean_name, clean_text


def clean(patch: dict[str, Any], *, new: bool) -> dict[str, Any]:
    """A preset from the API: stem (from a LoRA name), name (1-80 chars),
    text, strength (null or -2..2). Pure."""
    out: dict[str, Any] = {}
    if new:
        stem = model_stem(str(patch.get("lora") or patch.get("stem") or "").strip())
        if not stem:
            raise PresetError("lora is required")
        out["stem"] = stem
    if "name" in patch or new:
        out["name"] = clean_name(patch)
    if "text" in patch or new:
        out["text"] = clean_text(patch)
    if "strength" in patch:
        s = patch["strength"]
        if s is not None and (
            isinstance(s, bool) or not isinstance(s, (int, float)) or not -2 <= s <= 2
        ):
            raise PresetError("strength must be null or between -2 and 2")
        out["strength"] = None if s is None else round(float(s), 2)
    return out


store = Store(
    t.lora_presets,
    clean,
    [t.lora_presets.c.stem, sa.func.lower(t.lora_presets.c.name)],
    defaults={"strength": None},
)
