"""What Moiré is doing in the background, in one list for the UI's activity
indicator: scans, model downloads and loads, AI tagging, face finding,
re-reading prompts, deleting libraries and generating.

Each item is ``{key, kind, library_id?, done?, total?, unit?, phase?}``; the
frontend words them (``lib/backgroundTasks.ts``).
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter

from ..database import schema as t
from ..database.db import async_conn
from ..services import activity, face_detect
from ..services.ai_jobs import get_ai_job_manager, get_ai_settings
from ..services.ai_tagger import model_status_view
from ..services.generation_jobs import get_generation_manager

router = APIRouter()


def _download(key: str, kind: str, state: dict[str, Any]) -> dict[str, Any] | None:
    """A model download in flight, as bytes of the files' known sizes."""
    if state.get("status") != "downloading":
        return None
    files = state.get("files") or []
    sized = [f for f in files if f.get("total")]
    item: dict[str, Any] = {"key": key, "kind": kind, "unit": "bytes"}
    if sized and len(sized) == len(files):
        item["done"] = sum(int(f.get("downloaded") or 0) for f in sized)
        item["total"] = sum(int(f["total"]) for f in sized)
    return item


@router.get("")
async def background_activity():
    items: list[dict[str, Any]] = []

    async with async_conn() as conn:
        scans = (
            await conn.execute(
                sa.select(
                    t.libraries.c._id, t.libraries.c.scan_done, t.libraries.c.scan_total
                ).where(t.libraries.c.scanning.is_(True))
            )
        ).fetchall()
    for r in scans:
        items.append(
            {
                "key": f"scan:{r._id}",
                "kind": "scan",
                "library_id": r._id,
                "done": r.scan_done or 0,
                # 0 until the walk has counted the files (or while queued).
                "total": r.scan_total or None,
            }
        )

    items.extend(activity.snapshot())

    model = model_status_view(await get_ai_settings())
    download = _download("model-download", "model_download", model["model_download"])
    if download:
        items.append(download)
    elif (model.get("model_load") or {}).get("status") == "loading":
        items.append({"key": "model-load", "kind": "model_load"})

    for job in get_ai_job_manager().list_jobs(limit=20):
        if job.status in ("queued", "running", "cancelling"):
            items.append(
                {
                    "key": f"ai:{job.id}",
                    "kind": "ai_job",
                    "job_id": job.id,
                    "status": job.status,
                    "phase": job.phase,
                    "done": job.done + job.failed,
                    "total": job.total,
                    # A small job names its images, so an image's panel
                    # opened mid-job shows that job's progress.
                    **({"image_ids": job.image_ids()} if job.total <= 20 else {}),
                }
            )

    faces = _download(
        "face-download", "face_download", await face_detect.download_state()
    )
    if faces:
        items.append(faces)
    done, total = face_detect.progress()
    if total:
        items.append({"key": "faces", "kind": "faces", "done": done, "total": total})

    gen = get_generation_manager().status()
    if gen.get("busy"):
        items.append(
            {"key": "generate", "kind": "generate", "total": gen["queue_remaining"]}
        )

    return {"items": items}
