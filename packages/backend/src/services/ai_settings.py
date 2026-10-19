"""AI tagger settings: defaults, validation, and persistence.

Kept separate from the job manager so the validation/clamping rules
(:func:`clean_settings_patch`) are a pure, testable surface.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from ..core.config import settings
from .ai_tagger import get_tagger_manager

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


async def _read_ai_doc() -> dict[str, Any] | None:
    """The stored "ai" settings overrides, or None if never written."""
    async with async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == "ai")
            )
        ).scalar()


async def get_ai_settings() -> dict[str, Any]:
    doc = await _read_ai_doc()
    if doc is None:
        async with async_tx() as conn:
            await conn.execute(
                sqlite_insert(t.app_settings)
                .values(_id="ai", doc=dict(DEFAULT_AI_SETTINGS))
                .on_conflict_do_nothing(index_elements=[t.app_settings.c._id])
            )
        return dict(DEFAULT_AI_SETTINGS)
    return {**DEFAULT_AI_SETTINGS, **doc}


async def update_ai_settings(patch: dict[str, Any]) -> dict[str, Any]:
    clean = clean_settings_patch(patch)

    existing = await _read_ai_doc() or {}
    new_doc = {**existing, **clean}
    async with async_tx() as conn:
        stmt = sqlite_insert(t.app_settings).values(_id="ai", doc=new_doc)
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.app_settings.c._id], set_={"doc": stmt.excluded.doc}
        )
        await conn.execute(stmt)

    # Apply runtime knobs immediately.
    if "idle_unload_s" in clean:
        get_tagger_manager().set_idle_unload_s(int(clean["idle_unload_s"]))

    return await get_ai_settings()
