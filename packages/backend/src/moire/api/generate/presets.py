"""Prompt and LoRA presets, and LoRA activation words."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ...services import lora_presets, preset_store, prompt_presets
from ...services.generation_jobs import get_generation_manager
from ...services.lora_words import suggestions as lora_suggestions

router = APIRouter()


# -- Prompt and LoRA presets ------------------------------------------------------


def preset_routes(prefix: str, store: preset_store.Store) -> None:
    """The four CRUD routes for one preset kind; PresetError is a 400."""

    @router.get(prefix)
    async def list_presets():
        return await store.listing()

    @router.post(prefix)
    async def create_preset(body: dict[str, Any]):
        try:
            return await store.create(body)
        except preset_store.PresetError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @router.put(prefix + "/{preset_id}")
    async def update_preset(preset_id: str, body: dict[str, Any]):
        try:
            row = await store.update(preset_id, body)
        except preset_store.PresetError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        if row is None:
            raise HTTPException(status_code=404, detail="Preset not found")
        return row

    @router.delete(prefix + "/{preset_id}")
    async def delete_preset(preset_id: str):
        if not await store.delete(preset_id):
            raise HTTPException(status_code=404, detail="Preset not found")
        return {"ok": True}


preset_routes("/presets", prompt_presets.store)
preset_routes("/lora-presets", lora_presets.store)


@router.get("/lora-words")
async def lora_words(name: str, describe: bool = False):
    """Suggested activation words for the installed LoRA file ``name``;
    ``describe`` keeps training tags common in the library (a character
    LoRA's hair and eyes)."""
    return await lora_suggestions(
        name, get_generation_manager().client, describe=describe
    )
