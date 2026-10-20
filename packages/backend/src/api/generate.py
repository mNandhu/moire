"""Generation (ComfyUI): settings, status, Generators, batches.

The browser never talks to ComfyUI; everything goes through here. Progress
is polled (``GET /status``, ``GET /batches/{id}``) like the AI job status.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..models.library import LibraryIn
from ..services import (
    comfy_models,
    comfy_settings,
    generation_batches,
    generation_estimate,
    generator_setup,
    library_watch,
    lora_presets,
    prompt_presets,
    recipes,
    tag_categories,
)
from ..services.generation_jobs import (
    Invalid,
    Rejected,
    Unavailable,
    get_generation_manager,
    load_generator,
)
from ..services.generator_setup import SetupError

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


class LoraChoice(BaseModel):
    stem: str
    name: str | None = None


class LoraIn(BaseModel):
    name: str
    strength: float = 1.0


class SeedIn(BaseModel):
    mode: str = "random"
    value: int | None = None


class CharacterIn(BaseModel):
    #: The character's page key (the tagger's full name).
    tag: str = Field(..., min_length=1)
    #: Display name, for the batch's auto name.
    label: str = Field("", max_length=200)
    #: The Character block's tags as sent: character tag + identity left after drops.
    tags: list[str] = Field(default_factory=list)
    lora: LoraIn | None = None


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
    steps: int | None = Field(None, ge=1, le=200)
    cfg: float | None = Field(None, ge=0, le=30)


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
    per_request: int | None = Field(None, ge=1, le=64)
    name: str | None = None


class RenameIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class RetryIn(BaseModel):
    single: bool = False


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


def _rejected(e: Rejected) -> JSONResponse:
    return JSONResponse(
        status_code=422, content={"detail": e.message, "node_errors": e.node_errors}
    )


async def _settings_view() -> dict[str, Any]:
    s = await comfy_settings.get_settings()
    out = comfy_settings.public(s)
    out["output_path"] = None
    if s.get("output_library_id"):
        from ..api.libraries import list_libraries

        lib = next(
            (x for x in await list_libraries() if x["_id"] == s["output_library_id"]),
            None,
        )
        out["output_path"] = lib["path"] if lib else None
    return out


# -- ComfyUI connection -----------------------------------------------------------


@router.get("/comfyui")
async def get_comfyui():
    return await _settings_view()


@router.put("/comfyui")
async def put_comfyui(body: ComfyPatch):
    patch = body.model_dump(exclude_none=True)
    output_path = patch.pop("output_path", None)
    if output_path is not None:
        if not output_path.strip():
            patch["output_library_id"] = None
        else:
            from ..api.libraries import add_library, update_library
            from ..models.library import LibraryUpdate

            try:
                lib = await add_library(
                    LibraryIn(path=output_path, name="ComfyUI output")
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            # Outputs reach the library through its watcher, so a reused
            # library with watching off gets it turned on.
            if not library_watch.is_watching(lib["_id"]):
                await update_library(lib["_id"], LibraryUpdate(watch_enabled=True))
            patch["output_library_id"] = lib["_id"]
    if patch.get("ca_cert"):
        import ssl

        try:
            ssl.create_default_context(cafile=patch["ca_cert"].strip())
        except (OSError, ssl.SSLError) as e:
            raise HTTPException(
                status_code=400, detail=f"Can't read the certificate: {e}"
            ) from e
    before = await comfy_settings.get_settings()
    after = await comfy_settings.update_settings(patch)
    if any(before.get(k) != after.get(k) for k in ("address", "headers", "ca_cert")):
        await get_generation_manager().configure()
    return await _settings_view()


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
    queue = await generation_estimate.queue_plan(m.started)
    active = await generation_batches.active_summary(m)
    for a in active:
        # Seconds left on the batch; None when some request can't be told.
        a["eta"] = queue["batches"].get(a["_id"])
    return {**m.status(), "active": active, "eta": queue["total"]}


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
    proposed = (await generator_setup.setup_view(graph, new))["proposed"]
    return await generator_setup.setup_view(
        graph, new, generator_setup.carry_slots(gen["slots"], graph, proposed)
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
        batch_id = await generation_batches.start_test(m, generator_id, body.checkpoint)
    except Unavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Invalid as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Rejected as e:
        return _rejected(e)
    return {"batch_id": batch_id}


# -- Character recipes -----------------------------------------------------------


@router.get("/character-names")
async def character_names():
    """Every character the AI tagger knows by name, in or out of the library:
    for prompt autocomplete and making a character from scratch."""
    return sorted((await tag_categories.load()).names)


@router.get("/recipes/{tag}")
async def get_recipe(tag: str):
    r = await recipes.recipe(tag)
    if r is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return r


@router.put("/recipes/{tag}")
async def put_recipe(tag: str, patch: dict[str, Any]):
    try:
        r = await recipes.update(tag, patch)
    except recipes.RecipeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if r is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return r


# -- Prompt presets --------------------------------------------------------------


@router.get("/presets")
async def list_presets():
    return await prompt_presets.listing()


@router.post("/presets")
async def create_preset(body: dict[str, Any]):
    try:
        return await prompt_presets.create(body)
    except prompt_presets.PresetError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/presets/{preset_id}")
async def update_preset(preset_id: str, body: dict[str, Any]):
    try:
        row = await prompt_presets.update(preset_id, body)
    except prompt_presets.PresetError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if row is None:
        raise HTTPException(status_code=404, detail="Preset not found")
    return row


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: str):
    if not await prompt_presets.delete(preset_id):
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"ok": True}


# -- LoRA activation presets ------------------------------------------------------


@router.get("/lora-presets")
async def list_lora_presets():
    return await lora_presets.listing()


@router.post("/lora-presets")
async def create_lora_preset(body: dict[str, Any]):
    try:
        return await lora_presets.create(body)
    except lora_presets.PresetError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/lora-presets/{preset_id}")
async def update_lora_preset(preset_id: str, body: dict[str, Any]):
    try:
        row = await lora_presets.update(preset_id, body)
    except lora_presets.PresetError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if row is None:
        raise HTTPException(status_code=404, detail="Preset not found")
    return row


@router.delete("/lora-presets/{preset_id}")
async def delete_lora_preset(preset_id: str):
    if not await lora_presets.delete(preset_id):
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"ok": True}


@router.get("/lora-words")
async def lora_words(name: str, describe: bool = False):
    """Suggested activation words for the installed LoRA file ``name``;
    ``describe`` keeps training tags common in the library (a character
    LoRA's hair and eyes)."""
    return await lora_presets.suggestions(
        name, get_generation_manager().client, describe=describe
    )


# -- Batches ----------------------------------------------------------------------


@router.post("/batches")
async def queue_batch(body: BatchIn):
    m = get_generation_manager()
    try:
        batch_id = await m.queue_batch(body.model_dump())
    except Unavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Invalid as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Rejected as e:
        return _rejected(e)
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


@router.get("/batches/{batch_id}")
async def get_batch(batch_id: int):
    out = await generation_batches.get_batch(batch_id, get_generation_manager())
    if out is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return out


@router.patch("/batches/{batch_id}")
async def rename_batch(batch_id: int, body: RenameIn):
    if not await generation_batches.rename(batch_id, body.name):
        raise HTTPException(status_code=404, detail="Batch not found")
    return await get_batch(batch_id)


@router.post("/batches/{batch_id}/requeue")
async def requeue_batch(batch_id: int):
    m = get_generation_manager()
    try:
        new_id = await m.requeue(batch_id)
    except Unavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Invalid as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Rejected as e:
        return _rejected(e)
    return await generation_batches.get_batch(new_id, m)


@router.post("/batches/{batch_id}/requests/{request_id}/retry")
async def retry_request(batch_id: int, request_id: int, body: RetryIn):
    try:
        await get_generation_manager().retry(batch_id, request_id, single=body.single)
    except Invalid as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return await get_batch(batch_id)


@router.post("/batches/{batch_id}/cancel")
async def cancel_batch(batch_id: int):
    await get_generation_manager().cancel(batch_id)
    return await get_batch(batch_id)


@router.post("/batches/{batch_id}/requests/{request_id}/cancel")
async def cancel_request(batch_id: int, request_id: int):
    await get_generation_manager().cancel(batch_id, request_id)
    return await get_batch(batch_id)
