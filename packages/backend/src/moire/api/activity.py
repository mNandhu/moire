"""What Moiré is doing in the background, in one list for the UI's activity
indicator: scans, model downloads and loads, AI tagging, face finding,
re-reading prompts, deleting libraries and generating.

Each item is ``{key, kind, library_id?, done?, total?, unit?, phase?}``; the
frontend words them (``lib/backgroundTasks.ts``). ``ended`` counts, per kind,
the work that has ended since the server started, so the UI can refresh after
work that came and went between two polls.
"""

from __future__ import annotations

import logging
from typing import Any

import sqlalchemy as sa
from fastapi import APIRouter

from ..database import schema as t
from ..database.db import async_conn
from ..services import activity, face_detect, generation_estimate
from ..services.ai_jobs import get_ai_job_manager, get_ai_settings
from ..services.ai_tagger import model_status_view, resolved_model_target
from ..services.ai_tagger_download import activity_item
from ..services.generation_jobs import get_generation_manager

router = APIRouter()
logger = logging.getLogger("moire.activity")


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

    settings = await get_ai_settings()
    model = model_status_view(settings)
    download = activity_item(
        "model-download", "model_download", model["model_download"]
    )
    if download:
        items.append(download)
    elif (model.get("model_load") or {}).get("status") == "loading":
        items.append({"key": "model-load", "kind": "model_load"})

    items.extend(job.activity_item() for job in get_ai_job_manager().active_jobs())
    items.extend(face_detect.activity_items(resolved_model_target(settings)[1]))

    manager = get_generation_manager()
    gen = manager.status()
    if gen.get("busy"):
        try:
            eta = (
                await generation_estimate.queue_plan(manager.started, manager.current)
            )["total"]
        except Exception:
            # The estimate is extra; the activity list still answers.
            logger.exception("Couldn't estimate the generation queue")
            eta = None
        items.append(
            {
                "key": "generate",
                "kind": "generate",
                "total": gen["queue_remaining"],
                # Seconds left on our queue, from past runs; absent when
                # some of it can't be told.
                **({"eta_s": eta} if eta else {}),
            }
        )

    return {"items": items, "ended": activity.ended()}
