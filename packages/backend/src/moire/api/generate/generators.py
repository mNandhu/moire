"""Generators (set up, tested, edited) and the Remix read."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ...services import generation_batches, generator_setup, generator_test, remix
from ...services.generation_jobs import get_generation_manager
from ...services.generator_setup import SetupError
from ...services.generators_store import load_generator
from .queue_errors import QUEUE_ERRORS, queue_error

router = APIRouter()


class TestIn(BaseModel):
    checkpoint: str | None = None


class SourceIn(BaseModel):
    """Where a custom Generator's graph comes from: a library image, or an
    uploaded Export (API) file's contents."""

    image_id: str | None = None
    graph: dict[str, Any] | None = None
    filename: str | None = Field(None, max_length=300)


class GeneratorIn(BaseModel):
    source: SourceIn
    name: str = Field(..., min_length=1, max_length=200)
    slots: dict[str, Any]
    defaults: dict[str, str] = {}


class GeneratorPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    # A newer version of the workflow: its library image.
    source: dict[str, str] | None = None
    slots: dict[str, Any] | None = None
    defaults: dict[str, str] | None = None


# -- Generators -------------------------------------------------------------------


@router.get("/generators")
async def list_generators():
    """The built-in first, then custom Generators oldest first."""
    m = get_generation_manager()
    out = []
    for gid in ["builtin", *await generator_setup.custom_ids()]:
        view = await generation_batches.generator_view(m, gid)
        if view:
            out.append(view)
    return out


async def _source(body: SourceIn) -> tuple[dict[str, Any], dict[str, Any]]:
    if body.image_id:
        return await generator_setup.image_source(body.image_id)
    if body.graph is not None:
        name = (body.filename or "").rsplit("/", 1)[-1]
        return generator_setup.parse_upload(body.graph), {
            "kind": "upload",
            "filename": name or None,
        }
    raise SetupError("Choose an image or a workflow file")


@router.post("/generators/discover")
async def discover_generator(body: SourceIn):
    """What setup finds in a source, before anything is saved."""
    try:
        graph, source = await _source(body)
        return await generator_setup.setup_view(graph, source)
    except SetupError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/generators")
async def create_generator(body: GeneratorIn):
    try:
        graph, source = await _source(body.source)
        gen_id = await generator_setup.create(
            graph, source, body.name, body.slots, body.defaults
        )
    except SetupError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return await generation_batches.generator_view(get_generation_manager(), gen_id)


async def _custom(generator_id: str) -> dict[str, Any]:
    gen = await load_generator(generator_id)
    if gen is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if gen["kind"] != "custom":
        raise HTTPException(status_code=400, detail="The built-in can't be changed")
    return gen


@router.get("/generators/{generator_id}/setup")
async def generator_setup_view(generator_id: str, image: str | None = None):
    """The setup page for a saved Generator: its slots and defaults over a
    fresh discovery. With ``image`` (a newer version of its workflow): that
    graph, with the slots that still fit carried over."""
    gen = await _custom(generator_id)
    source = gen.get("source") or {}
    if not image:
        return await generator_setup.setup_view(gen["graph"], source, gen["slots"])
    try:
        graph, new = await generator_setup.image_source(image)
    except SetupError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    new = {**new, "defaults": source.get("defaults")}
    return await generator_setup.setup_view(
        graph, new, carry_from=(gen["slots"], gen["graph"])
    )


@router.get("/generators/{generator_id}/latest")
async def generator_latest(generator_id: str):
    """A newer version of the workflow in the library, if there is one."""
    gen = await _custom(generator_id)
    return {"newer": await generator_setup.newer_version(gen)}


@router.put("/generators/{generator_id}")
async def put_generator(generator_id: str, body: GeneratorPatch):
    gen = await _custom(generator_id)
    try:
        await generator_setup.update(gen, body.model_dump(exclude_none=True))
    except SetupError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return await generation_batches.generator_view(
        get_generation_manager(), generator_id
    )


@router.delete("/generators/{generator_id}")
async def delete_generator(generator_id: str):
    await _custom(generator_id)
    try:
        await generator_setup.delete(generator_id)
    except SetupError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return {"ok": True}


@router.get("/generators/{generator_id}")
async def get_generator(generator_id: str):
    view = await generation_batches.generator_view(
        get_generation_manager(), generator_id
    )
    if view is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return view


@router.post("/generators/{generator_id}/test")
async def test_generator(generator_id: str, body: TestIn):
    m = get_generation_manager()
    try:
        batch_id = await generator_test.start_test(m, generator_id, body.checkpoint)
    except QUEUE_ERRORS as e:
        return queue_error(e)
    return {"batch_id": batch_id}


# -- Remix ---------------------------------------------------------------------


@router.get("/remix/{image_id:path}")
async def get_remix(image_id: str, full: bool = False):
    """The image's workflow for the viewer; with ``full``, what Remix starts
    the composer from."""
    r = await (remix.remix_doc if full else remix.remix_info)(image_id)
    if r is None:
        raise HTTPException(status_code=404, detail="No generation data")
    return r
