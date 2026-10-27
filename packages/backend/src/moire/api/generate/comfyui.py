"""ComfyUI connection settings, models and the generation status."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ...services import (
    comfy_connection,
    comfy_models,
    library_ops,
    generation_batches,
    generation_estimate,
)
from ...services.generation_jobs import get_generation_manager

router = APIRouter()


class ComfyPatch(BaseModel):
    address: str | None = None
    headers: dict[str, str] | None = None
    builtin_per_request: int | None = None
    download_outputs: bool | None = None
    #: PEM certificate for an HTTPS ComfyUI with a self-signed certificate.
    ca_cert: str | None = None
    #: Folder ComfyUI saves into; registered as (or matched to) a library.
    output_path: str | None = None
    #: ComfyUI's own output folder as Moiré sees it ("" forgets it).
    output_root: str | None = None
    #: What a character picked in Generate starts wearing: none / default.
    new_character_outfit: str | None = None


class LoraChoice(BaseModel):
    stem: str
    name: str | None = None


# -- ComfyUI connection -----------------------------------------------------------


@router.get("/comfyui")
async def get_comfyui():
    return await comfy_connection.settings_view()


@router.put("/comfyui")
async def put_comfyui(body: ComfyPatch):
    try:
        await comfy_connection.apply_patch(body.model_dump(exclude_none=True))
    except (library_ops.BadPath, comfy_connection.SettingsError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except library_ops.NotFound as e:
        raise HTTPException(status_code=404, detail="Library not found") from e
    return await comfy_connection.settings_view()


@router.post("/comfyui/test")
async def test_comfyui():
    m = get_generation_manager()
    if m.client is None:
        await m.configure()
    ok = await m.check(refresh_models=True)
    return {**m.status(), "ok": ok}


@router.post("/comfyui/refresh")
async def refresh_models():
    m = get_generation_manager()
    if not await m.check(refresh_models=True):
        raise HTTPException(status_code=503, detail=m.error or "ComfyUI unreachable")
    return await get_models()


@router.get("/comfyui/models")
async def get_models():
    installed = await comfy_models.installed()
    return {
        "checkpoints": installed["checkpoint"],
        "loras": installed["lora"],
        "embeddings": installed["embedding"],
        **{f"{k}s": v for k, v in (await comfy_models.sampling()).items()},
        "matching": await comfy_models.matching(),
    }


@router.put("/comfyui/lora-choices")
async def put_lora_choice(body: LoraChoice):
    await comfy_models.set_choice(body.stem, body.name)
    return {"ok": True}


@router.get("/status")
async def status():
    """Connection, global busy, and the queue card's active batches."""
    m = get_generation_manager()
    queue = await generation_estimate.queue_plan(m.started, m.current)
    active = await generation_batches.active_summary(m)
    for a in active:
        # Seconds left on the batch; None when some request can't be told.
        a["eta"] = queue["batches"].get(a["_id"])
        # Seconds until it starts and is done, its turns among the others counted.
        a["starts_in"] = queue["starts"].get(a["_id"])
        a["done_in"] = queue["ends"].get(a["_id"])
    return {**m.status(), "active": active, "eta": queue["total"]}
