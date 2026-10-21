from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from ..services import face_detect, image_tags

from ..services.ai_jobs import (
    get_ai_job_manager,
    get_ai_settings,
    update_ai_settings,
)
from ..services.ai_tagger import (
    get_tagger_manager,
    model_status_view,
    resolved_model_target,
)
from ..services.ai_tagger_download import get_download_manager

router = APIRouter()


class SettingsPatch(BaseModel):
    model_repo: str | None = None
    general_thresh: float | None = None
    character_thresh: float | None = None
    general_mcut: bool | None = None
    character_mcut: bool | None = None
    max_general: int | None = None
    max_character: int | None = None
    idle_unload_s: int | None = None
    cache_dir: str | None = None
    prompt_positive_only: bool | None = None
    face_detect: bool | None = None


class TagRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)
    force: bool = False


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
    """AI-tag coverage: how many images carry AI tags, globally and per library.

    ``has_ai_tags`` is the summary flag maintained by ``image_tags`` and
    backfilled onto older docs at startup, so a single grouped count is exact.
    Quarantined images are excluded to match the default gallery.
    """
    stmt = (
        sa.select(
            t.images.c.library_id,
            sa.func.count().label("total"),
            sa.func.coalesce(
                sa.func.sum(sa.cast(t.images.c.has_ai_tags, sa.Integer)), 0
            ).label("ai_tagged"),
            # No tags of any kind (`has_tags` false). The gallery's no_tags
            # filter, counted so the Tags page shortcut can show its size.
            sa.func.coalesce(
                sa.func.sum(
                    sa.case(
                        (sa.func.coalesce(t.images.c.has_tags, False).is_(False), 1),
                        else_=0,
                    )
                ),
                0,
            ).label("no_tags"),
        )
        .where(sa.func.coalesce(t.images.c.quarantined, False).is_(False))
        .group_by(t.images.c.library_id)
        .order_by(sa.text("total DESC"))
    )
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    per_library = [
        {
            "library_id": r.library_id,
            "total": r.total,
            "ai_tagged": int(r.ai_tagged),
        }
        for r in rows
    ]
    total = sum(r["total"] for r in per_library)
    ai_tagged = sum(r["ai_tagged"] for r in per_library)
    return {
        "total": total,
        "ai_tagged": ai_tagged,
        "untagged": total - ai_tagged,
        "no_tags": sum(int(r.no_tags) for r in rows),
        "per_library": per_library,
    }
