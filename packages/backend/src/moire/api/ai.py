from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, create_model


from ..services import ai_coverage as ai_coverage_service, face_detect, image_tags
from ..services.ai_settings import (
    DEFAULT_AI_SETTINGS,
    get_ai_settings,
    update_ai_settings,
)
from ..services.ai_jobs import get_ai_job_manager
from ..services.ai_tagger import (
    get_tagger_manager,
    model_status_view,
    resolved_model_target,
)
from ..services.ai_tagger_download import get_download_manager

router = APIRouter()


# One optional field per AI setting, typed from its default, so a new setting
# in DEFAULT_AI_SETTINGS is accepted here without a second edit.
SettingsPatch = create_model(
    "SettingsPatch",
    **{key: (type(value) | None, None) for key, value in DEFAULT_AI_SETTINGS.items()},
)


class TagRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    force: bool = False
    # Re-tag: clear each image's AI tags and rating first, so what it ends
    # with is only this run's (or nothing, if the run is cancelled).
    retag: bool = False


class TagUntaggedRequest(BaseModel):
    limit: int = 200
    library_id: str | None = None


@router.get("/settings")
async def ai_get_settings():
    return await get_ai_settings()


@router.post("/settings")
async def ai_set_settings(patch: SettingsPatch):
    return await update_ai_settings(patch.model_dump(exclude_none=True))


@router.get("/status")
async def ai_status():
    jm = get_ai_job_manager()
    s = await get_ai_settings()
    return {
        **model_status_view(s),
        "jobs": {
            "recent": [j.public() for j in jm.list_jobs(limit=10)],
            "queue_depth": jm.queue_depth(),
        },
        "settings": s,
    }


@router.post("/model/load")
async def ai_model_load():
    s = await get_ai_settings()
    repo, cache_dir = resolved_model_target(s)
    started = get_tagger_manager().start_load(model_repo=repo, cache_dir=cache_dir)
    return {
        "ok": True,
        "started": started,
        "model": get_tagger_manager().status(),
        "model_load": get_tagger_manager().load_status(),
    }


@router.get("/model/load-status")
async def ai_model_load_status():
    return get_tagger_manager().load_status()


@router.post("/model/load-cancel")
async def ai_model_load_cancel():
    ok = await get_tagger_manager().cancel_load()
    return {"ok": ok, "model_load": get_tagger_manager().load_status()}


@router.get("/model/download-status")
async def ai_model_download_status():
    s = await get_ai_settings()
    repo, cache_dir = resolved_model_target(s)
    return (
        get_download_manager().get_state(model_repo=repo, cache_dir=cache_dir).as_dict()
    )


@router.post("/model/download-cancel")
async def ai_model_download_cancel():
    s = await get_ai_settings()
    repo, cache_dir = resolved_model_target(s)
    ok = await get_download_manager().cancel(model_repo=repo, cache_dir=cache_dir)
    return {
        "ok": ok,
        "download": get_download_manager()
        .get_state(model_repo=repo, cache_dir=cache_dir)
        .as_dict(),
    }


@router.get("/faces")
async def faces_status():
    """The face detector (character avatars): switched on, downloaded, the
    download's progress, and how many images wait to be looked at."""
    return await face_detect.status()


@router.post("/faces/download")
async def faces_download():
    await face_detect.start_download()
    return await face_detect.status()


@router.post("/faces/download-cancel")
async def faces_download_cancel():
    ok = await face_detect.cancel_download()
    return {"ok": ok, **(await face_detect.status())}


@router.post("/model/unload")
async def ai_model_unload():
    await get_tagger_manager().unload()
    return {"ok": True, "model": get_tagger_manager().status()}


@router.post("/tag")
async def ai_tag(req: TagRequest):
    jm = get_ai_job_manager()
    if req.retag:
        for image_id in req.ids:
            await image_tags.clear_ai(image_id)
    # An image another job still holds is skipped: that job tags it after
    # the clear (a job releases each image once it has tagged it).
    job = await jm.enqueue(ids=req.ids, force=bool(req.force))
    return {"job_id": job.id, "queued": job.total, "skipped": job.skipped}


@router.post("/tag-untagged")
async def ai_tag_untagged(req: TagUntaggedRequest):
    jm = get_ai_job_manager()
    job = await jm.enqueue_untagged(limit=req.limit, library_id=req.library_id)
    if job is None:
        return {"job_id": None, "queued": 0}
    return {"job_id": job.id, "queued": job.total}


@router.post("/clear-ai-tags")
async def ai_clear_all_ai_tags():
    """Remove AI-generated tags and AI metadata from ALL images.

    Keeps manual tags (manual: prefix).
    """
    matched, modified = await image_tags.clear_ai_all()
    return {"matched": matched, "modified": modified}


@router.get("/jobs")
async def ai_list_jobs(limit: int = 20):
    jm = get_ai_job_manager()
    return [j.public() for j in jm.list_jobs(limit=limit)]


@router.get("/jobs/{job_id}")
async def ai_get_job(job_id: str):
    jm = get_ai_job_manager()
    j = jm.get_job(job_id)
    if j is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return j.public()


@router.post("/jobs/{job_id}/cancel")
async def ai_cancel_job(job_id: str):
    jm = get_ai_job_manager()
    ok = await jm.cancel(job_id)
    j = jm.get_job(job_id)
    return {
        "ok": ok,
        "job": (j.public() if j else None),
    }


@router.get("/coverage")
async def ai_coverage():
    """AI-tag coverage, globally and per library (quarantined images excluded)."""
    return await ai_coverage_service.coverage()
