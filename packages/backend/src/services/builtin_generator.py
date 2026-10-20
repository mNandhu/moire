"""The built-in Generator: ComfyUI's default txt2img graph, plus its slots.

Stored in the ``generators`` table on first use (id ``builtin``) so batches can
point at it like any other Generator; it still needs a passing test run before
it is ready, which proves the output folder mapping and that the checkpoint
loads.
"""

from __future__ import annotations

import copy
from typing import Any

BUILTIN_ID = "builtin"
BUILTIN_NAME = "Built-in"

_GRAPH: dict[str, dict[str, Any]] = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 0,
            "steps": 28,
            "cfg": 6.0,
            "sampler_name": "euler_ancestral",
            "scheduler": "normal",
            "denoise": 1.0,
            "model": ["4", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ""}},
    "5": {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 832, "height": 1216, "batch_size": 1},
    },
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["4", 1]}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["4", 1]}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
    "9": {
        "class_type": "SaveImage",
        "inputs": {"filename_prefix": "moire/gen", "images": ["8", 0]},
    },
}

_SLOTS: dict[str, Any] = {
    "positive": ["6", "text"],
    "negative": ["7", "text"],
    "seeds": [["3", "seed"]],
    "width": ["5", "width"],
    "height": ["5", "height"],
    "batch_size": ["5", "batch_size"],
    "checkpoint": ["4", "ckpt_name"],
    "lora_model": ["4", 0],
    "lora_clip": ["4", 1],
}


def graph() -> dict[str, dict[str, Any]]:
    return copy.deepcopy(_GRAPH)


def slots() -> dict[str, Any]:
    return copy.deepcopy(_SLOTS)
