"""The one rule for naming a model file (LoRA, checkpoint, embedding) by its
stem. Pure; the frontend's ``stemOf`` (lib/modelNames.ts) mirrors it."""

from __future__ import annotations

import re

_MODEL_EXT = re.compile(r"\.(?:safetensors|ckpt|pt|pth|bin)$", re.IGNORECASE)


def model_stem(name: str) -> str:
    """``"styles/flat_color_xl.safetensors"`` -> ``"flat_color_xl"``: no folder,
    no extension (only a real model extension, so ``"v1.5_style"`` keeps its
    dot), trimmed. The key that matches ``image_loras.name``."""
    base = re.split(r"[\\/]", name.strip())[-1]
    return _MODEL_EXT.sub("", base).strip()
