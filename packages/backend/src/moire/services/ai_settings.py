"""AI tagger settings: defaults, validation, and persistence.

Kept separate from the job manager so the validation/clamping rules
(:func:`clean_settings_patch`) are a pure, testable surface.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.dialects.sqlite import insert as sqlite_insert


from ..database.db import async_tx
from ..database import schema as t
from ..core.config import settings
from . import app_settings
from .ai_tagger import get_tagger_manager

# The app_settings row holding these (also read by extraction_settings).
ROW = "ai"

DEFAULT_AI_SETTINGS: dict[str, Any] = {
    "model_repo": "SmilingWolf/wd-vit-tagger-v3",
    "general_thresh": 0.35,
    "character_thresh": 0.85,
    "general_mcut": False,
    "character_mcut": False,
    "max_general": 80,
    "max_character": 40,
    "idle_unload_s": 300,
    "cache_dir": str(settings.model_cache_dir_path),
    # When on (default), prompt: tags are derived from the positive prompt only,
    # so negative-prompt words don't pollute search. Applied at reprojection.
    "prompt_positive_only": True,
    # Crop character avatars to the face once the face model is downloaded
    # (services/face_detect.py). On by default: it does nothing until then.
    "face_detect": True,
}


def prompt_positive_only(doc: dict[str, Any] | None) -> bool:
    """The ``prompt_positive_only`` switch from a stored "ai" doc (``None`` if
    never written). Settings that predate the flag get the default."""
    default = DEFAULT_AI_SETTINGS["prompt_positive_only"]
    return bool((doc or {}).get("prompt_positive_only", default))


def clean_settings_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """Drop unknown keys and coerce/clamp known ones. Pure; no I/O.

    Invalid ``idle_unload_s`` is dropped (rather than raising) so a bad value
    can't wedge settings updates.
    """
    allowed = set(DEFAULT_AI_SETTINGS.keys())
    clean: dict[str, Any] = {k: v for k, v in patch.items() if k in allowed}

    if "idle_unload_s" in clean:
        try:
            clean["idle_unload_s"] = max(0, int(clean["idle_unload_s"]))
        except Exception:
            clean.pop("idle_unload_s", None)

    if "general_thresh" in clean:
        clean["general_thresh"] = float(clean["general_thresh"])
    if "character_thresh" in clean:
        clean["character_thresh"] = float(clean["character_thresh"])

    if "max_general" in clean:
        clean["max_general"] = max(0, int(clean["max_general"]))
    if "max_character" in clean:
        clean["max_character"] = max(0, int(clean["max_character"]))

    if "model_repo" in clean:
        clean["model_repo"] = str(clean["model_repo"]).strip()

    if "prompt_positive_only" in clean:
        clean["prompt_positive_only"] = bool(clean["prompt_positive_only"])
    if "face_detect" in clean:
        clean["face_detect"] = bool(clean["face_detect"])

    return clean


async def get_ai_settings() -> dict[str, Any]:
    doc = await app_settings.read(ROW)
    if doc is None:
        async with async_tx() as conn:
            await conn.execute(
                sqlite_insert(t.app_settings)
                .values(_id=ROW, doc=dict(DEFAULT_AI_SETTINGS))
                .on_conflict_do_nothing(index_elements=[t.app_settings.c._id])
            )
        return dict(DEFAULT_AI_SETTINGS)
    return {**DEFAULT_AI_SETTINGS, **doc}


async def update_ai_settings(patch: dict[str, Any]) -> dict[str, Any]:
    clean = clean_settings_patch(patch)

    before = await get_ai_settings()
    existing = await app_settings.read(ROW) or {}
    new_doc = {**existing, **clean}
    await app_settings.write(ROW, new_doc)

    # Apply runtime knobs immediately.
    if "idle_unload_s" in clean:
        get_tagger_manager().set_idle_unload_s(int(clean["idle_unload_s"]))

    after = await get_ai_settings()
    # Imported here: both reach back into this module's readers.
    from . import reproject, tag_index

    # Rescans only re-derive files that changed, so apply the switch now.
    if before.get("prompt_positive_only") != after.get("prompt_positive_only"):
        reproject.reproject_all_async()
    # The model's labels decide which tags are characters, which the cached
    # tag lists and character list carry.
    if any(before.get(k) != after.get(k) for k in ("model_repo", "cache_dir")):
        tag_index.invalidate()
    return after
