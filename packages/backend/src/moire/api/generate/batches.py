"""Batches: queue, estimate, list, rename, requeue, retry, cancel."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ...services import (
    comfy_settings,
    generation_batches,
    generation_estimate,
    outfits,
)
from ...services.generation_errors import Invalid
from ...services.generation_jobs import get_generation_manager
from ...services.generation_limits import CFG_RANGE, PER_REQUEST_MAX, STEPS_RANGE
from .queue_errors import QUEUE_ERRORS, queue_error

router = APIRouter()


class LoraIn(BaseModel):
    name: str
    strength: float = 1.0


class SeedIn(BaseModel):
    mode: str = "random"
    value: int | None = None


class OutfitIn(BaseModel):
    #: A saved outfit's id, or "default" (the computed one).
    id: str = Field(..., min_length=1, max_length=64)
    name: str = Field("", max_length=80)
    #: The tags sent, after this batch's chip edits.
    tags: list[str] = Field(default_factory=list, max_length=outfits.MAX_TAGS)


class CharacterIn(BaseModel):
    #: The character's page key (the tagger's full name).
    tag: str = Field(..., min_length=1)
    #: Display name, for the batch's auto name.
    label: str = Field("", max_length=200)
    #: The Character block's tags as sent: character tag + identity left after drops.
    tags: list[str] = Field(default_factory=list)
    lora: LoraIn | None = None
    #: What they wear, sent right after their tags.
    outfit: OutfitIn | None = None


class PartIn(BaseModel):
    kind: str
    role: str = ""
    label: str = ""
    text: str = ""
    name: str = ""


class SamplingIn(BaseModel):
    """Left out, a setting stays as the Generator's graph has it."""

    sampler: str | None = Field(None, max_length=200)
    scheduler: str | None = Field(None, max_length=200)
    steps: int | None = Field(None, ge=STEPS_RANGE[0], le=STEPS_RANGE[1])
    cfg: float | None = Field(None, ge=CFG_RANGE[0], le=CFG_RANGE[1])


class BatchIn(BaseModel):
    generator_id: str = "builtin"
    base: str = ""
    extra: list[str] = Field(default_factory=list)
    negative_base: str = ""
    negative_extra: list[str] = Field(default_factory=list)
    checkpoint: str | None = None
    sampling: SamplingIn | None = None
    loras: list[LoraIn] = Field(default_factory=list)
    character: CharacterIn | None = None
    #: Several characters, in prompt order (``character`` is one, for older clients).
    characters: list[CharacterIn] | None = None
    #: The layered composer: ordered parts; base / extra are for old batches.
    positive: list[PartIn] | None = None
    negative: list[PartIn] | None = None
    composer: dict[str, Any] | None = None
    width: int | None = None
    height: int | None = None
    seed: SeedIn = Field(default_factory=SeedIn)
    count: int = Field(1, ge=1, le=500)
    #: Images per request; left out, the Generator's.
    per_request: int | None = Field(None, ge=1, le=PER_REQUEST_MAX)
    name: str | None = None


class RenameIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class RetryIn(BaseModel):
    single: bool = False


# -- Batches ----------------------------------------------------------------------


@router.post("/batches")
async def queue_batch(body: BatchIn):
    m = get_generation_manager()
    try:
        batch_id = await m.queue_batch(body.model_dump())
    except QUEUE_ERRORS as e:
        return queue_error(e)
    return await generation_batches.get_batch(batch_id, m)


@router.post("/estimate")
async def estimate(body: BatchIn):
    """How long a batch would take if queued now, from past runs: its own
    seconds, the share of that spent loading its checkpoint, and the seconds
    of work queued ahead of it. ``None`` where there's no history to go on."""
    m = get_generation_manager()
    return await generation_estimate.for_new(
        body.model_dump(), await comfy_settings.get_settings(), m.started
    )


@router.get("/batches")
async def list_batches(limit: int = 50, before: int | None = None):
    return await generation_batches.list_batches(
        get_generation_manager(), limit=max(1, min(200, limit)), before=before
    )


async def _batch_or_404(batch_id: int) -> dict[str, Any]:
    out = await generation_batches.get_batch(batch_id, get_generation_manager())
    if out is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return out


@router.get("/batches/{batch_id}")
async def get_batch(batch_id: int):
    return await _batch_or_404(batch_id)


@router.patch("/batches/{batch_id}")
async def rename_batch(batch_id: int, body: RenameIn):
    if not await generation_batches.rename(batch_id, body.name):
        raise HTTPException(status_code=404, detail="Batch not found")
    return await _batch_or_404(batch_id)


@router.post("/batches/{batch_id}/requeue")
async def requeue_batch(batch_id: int):
    m = get_generation_manager()
    try:
        new_id = await m.requeue(batch_id)
    except QUEUE_ERRORS as e:
        return queue_error(e)
    return await generation_batches.get_batch(new_id, m)


@router.post("/batches/{batch_id}/requests/{request_id}/retry")
async def retry_request(batch_id: int, request_id: int, body: RetryIn):
    try:
        await get_generation_manager().retry(batch_id, request_id, single=body.single)
    except Invalid as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return await _batch_or_404(batch_id)


@router.post("/batches/{batch_id}/retry-failed")
async def retry_failed(batch_id: int):
    if not await generation_batches.batch_exists(batch_id):
        raise HTTPException(status_code=404, detail="Batch not found")
    await get_generation_manager().retry_failed(batch_id)
    return await _batch_or_404(batch_id)


@router.post("/batches/{batch_id}/cancel")
async def cancel_batch(batch_id: int):
    if not await generation_batches.batch_exists(batch_id):
        raise HTTPException(status_code=404, detail="Batch not found")
    # Null when it never ran and so was deleted.
    if await get_generation_manager().cancel(batch_id):
        return None
    return await _batch_or_404(batch_id)


@router.post("/batches/{batch_id}/requests/{request_id}/cancel")
async def cancel_request(batch_id: int, request_id: int):
    await get_generation_manager().cancel(batch_id, request_id)
    return await _batch_or_404(batch_id)
