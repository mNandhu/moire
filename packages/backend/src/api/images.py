from fastapi import APIRouter, HTTPException, Query, Request, Header, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
import mimetypes
import anyio  # type: ignore[import-not-found]
import os

import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from ..services.storage_fs import thumb_path, delete_thumb
from ..services import gen_metadata, image_tags, image_feed, tag_index
from ..services.image_feed import FeedFilter, FeedFilterError
from ..services.image_tags import find_image as _find_image_doc  # type: ignore
from ._utils import thumb_url


router = APIRouter()


class RatingPatch(BaseModel):
    rating: str


class ScorePatch(BaseModel):
    score: int


class QuarantinePatch(BaseModel):
    quarantined: bool


class PurgeBody(BaseModel):
    confirm: bool = False


def _attach_thumb_url(it: dict) -> None:
    """Replace the row's thumb_key with the streaming thumb route."""
    it.pop("thumb_key", None)
    it["thumb_url"] = thumb_url(it["_id"])


@router.get("")
async def list_images(
    response: Response,
    tags: list[str] | None = Query(default=None),
    logic: str = Query(default="and"),
    library_id: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    no_tags: int | None = Query(default=None, alias="no_tags"),
    no_ai_tags: int | None = Query(default=None, alias="no_ai_tags"),
    quarantined: int | None = Query(default=None),
    needs_mapping: int | None = Query(default=None),
    pterms: list[str] | None = Query(default=None),
    plogic: str = Query(default="and"),
    model: list[str] | None = Query(default=None),
    min_w: int | None = Query(default=None, ge=0),
    max_w: int | None = Query(default=None, ge=0),
    min_h: int | None = Query(default=None, ge=0),
    max_h: int | None = Query(default=None, ge=0),
    group_id: str | None = Query(default=None),
    workflow: str | None = Query(default=None, max_length=256),
    workflow_sig: str | None = Query(default=None, max_length=256),
    sort: str = Query(default="newest"),
    cursor: str | None = Query(default=None),
):
    if cursor and len(cursor) > 1024:
        raise HTTPException(status_code=422, detail="cursor too long")

    try:
        f = FeedFilter(
            tags=tags,
            logic=logic,
            library_id=library_id,
            no_tags=no_tags,
            no_ai_tags=no_ai_tags,
            quarantined=quarantined,
            needs_mapping=needs_mapping,
            pterms=pterms,
            plogic=plogic,
            model=model,
            min_w=min_w,
            max_w=max_w,
            min_h=min_h,
            max_h=max_h,
            group_id=group_id,
            workflow_id=workflow,
            workflow_sig=workflow_sig,
            sort=sort,
        )
    except FeedFilterError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not cursor and offset:
        response.headers["X-Moire-Warn"] = (
            "offset pagination is deprecated; prefer cursor-based pagination"
        )

    try:
        items, next_cursor = await image_feed.list_feed(
            f, cursor=cursor, limit=limit, offset=offset
        )
    except FeedFilterError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    # The next page's cursor, from the values the server sorted on; the body
    # stays a plain list so other callers are unaffected.
    if next_cursor:
        response.headers["X-Next-Cursor"] = next_cursor
    for it in items:
        _attach_thumb_url(it)
    return items


@router.get("/{image_id:path}/file")
async def get_image_file(
    image_id: str,
    request: Request,
    range: str | None = Header(default=None, alias="Range"),
):
    """Serve the original image file directly from the local filesystem."""
    img = await _find_image_doc(image_id, {"path": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    path = img.get("path")
    if not path:
        raise HTTPException(status_code=404, detail="File path not available")

    # Verify the file still exists on disk
    if not await anyio.to_thread.run_sync(lambda: os.path.isfile(path)):  # type: ignore[attr-defined]
        raise HTTPException(status_code=404, detail="Original file not found on disk")

    media_type, _ = mimetypes.guess_type(path)
    # FileResponse handles Range headers, ETag, Content-Length natively
    return FileResponse(
        path,
        media_type=media_type or "application/octet-stream",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Accept-Ranges": "bytes",
        },
    )


@router.head("/{image_id:path}/file")
async def head_image_file(image_id: str):
    """HEAD for the original image file: stat from the local filesystem."""
    img = await _find_image_doc(image_id, {"path": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    path = img.get("path")
    if not path:
        raise HTTPException(status_code=404, detail="File path not available")

    if not await anyio.to_thread.run_sync(lambda: os.path.isfile(path)):  # type: ignore[attr-defined]
        raise HTTPException(status_code=404, detail="Original file not found on disk")

    media_type, _ = mimetypes.guess_type(path)
    st = await anyio.to_thread.run_sync(lambda: os.stat(path))  # type: ignore[attr-defined]
    headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(st.st_size),
    }
    return Response(
        status_code=200,
        headers=headers,
        media_type=media_type or "application/octet-stream",
    )


@router.get("/{image_id:path}/thumb")
async def get_image_thumb(image_id: str):
    img = await _find_image_doc(image_id, {"thumb_key": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    thumb_key = img.get("thumb_key")
    if not thumb_key:
        raise HTTPException(status_code=404, detail="Thumbnail not available")

    # Determine media type from the key extension
    media_type = "image/webp" if thumb_key.endswith(".webp") else "image/jpeg"

    path = await anyio.to_thread.run_sync(lambda: thumb_path(thumb_key))  # type: ignore[attr-defined]
    if path is None:
        raise HTTPException(status_code=404, detail="Thumbnail not found on disk")
    # FileResponse handles ETag/Content-Length/sendfile natively.
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.head("/{image_id:path}/thumb")
async def head_image_thumb(image_id: str):
    img = await _find_image_doc(image_id, {"thumb_key": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    thumb_key = img.get("thumb_key", "") or ""
    media_type = "image/webp" if thumb_key.endswith(".webp") else "image/jpeg"
    headers = {"Accept-Ranges": "bytes"}
    return Response(status_code=200, headers=headers, media_type=media_type)


@router.get("/models")
async def list_models(library_id: str | None = Query(default=None)):
    """Distinct extracted checkpoints with image counts, for the model filter
    dropdown. Sorted by frequency."""
    stmt = (
        sa.select(t.images.c.gen_model, sa.func.count().label("count"))
        .where(t.images.c.gen_model.isnot(None))
        .group_by(t.images.c.gen_model)
        .order_by(sa.func.count().desc())
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [{"model": r.gen_model, "count": r.count} for r in rows]


@router.get("/stats")
async def image_stats(
    days: int = Query(default=371, ge=1, le=3660),
    tz_offset: int = Query(default=0, ge=-14 * 60, le=14 * 60),
):
    """Overview numbers: images per local calendar day over the last ``days``
    (by file mtime, the generation-time proxy the feed sorts on), and the
    quarantine backlog. ``tz_offset`` is minutes east of UTC, so days break at
    the viewer's midnight, not UTC's. Days with no images are omitted."""
    off = tz_offset * 60
    day = sa.func.date(t.images.c.mtime + off, "unixepoch")
    since = sa.func.strftime("%s", "now") - days * 86400
    activity = (
        sa.select(day.label("day"), sa.func.count().label("count"))
        .where(t.images.c.mtime.isnot(None), t.images.c.mtime >= since)
        .group_by(day)
        .order_by(day)
    )
    quarantined = sa.select(sa.func.count()).where(t.images.c.quarantined.is_(True))
    async with async_conn() as conn:
        rows = (await conn.execute(activity)).fetchall()
        q = (await conn.execute(quarantined)).scalar_one()
    return {
        "activity": [{"day": r.day, "count": r.count} for r in rows],
        "quarantined": q,
    }


@router.get("/groups")
async def list_groups(
    tags: list[str] | None = Query(default=None),
    logic: str = Query(default="and"),
    library_id: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    no_tags: int | None = Query(default=None, alias="no_tags"),
    no_ai_tags: int | None = Query(default=None, alias="no_ai_tags"),
    quarantined: int | None = Query(default=None),
    needs_mapping: int | None = Query(default=None),
    pterms: list[str] | None = Query(default=None),
    plogic: str = Query(default="and"),
    model: list[str] | None = Query(default=None),
    min_w: int | None = Query(default=None, ge=0),
    max_w: int | None = Query(default=None, ge=0),
    min_h: int | None = Query(default=None, ge=0),
    max_h: int | None = Query(default=None, ge=0),
    workflow: str | None = Query(default=None, max_length=256),
    workflow_sig: str | None = Query(default=None, max_length=256),
    sort: str = Query(default="newest"),
):
    """Batch-collapsed view of the same feed: images sharing a gen_group_id fold
    into one entry (the newest member is the representative, plus a count).
    Prompt-less / ungrouped images stand alone. Grouping spans page boundaries
    because it's a full aggregation, not a paged-then-grouped pass."""
    try:
        f = FeedFilter(
            tags=tags,
            logic=logic,
            library_id=library_id,
            no_tags=no_tags,
            no_ai_tags=no_ai_tags,
            quarantined=quarantined,
            needs_mapping=needs_mapping,
            pterms=pterms,
            plogic=plogic,
            model=model,
            min_w=min_w,
            max_w=max_w,
            min_h=min_h,
            max_h=max_h,
            workflow_id=workflow,
            workflow_sig=workflow_sig,
            sort=sort,
        )
    except FeedFilterError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    out = await image_feed.list_groups(f, offset=offset, limit=limit)
    for it in out:
        _attach_thumb_url(it)
    return out


@router.get("/{image_id:path}/workflow")
async def get_image_workflow(image_id: str):
    """Generation data for copy-workflow / remix.

    Format-aware: ComfyUI returns the `workflow` (UI graph, drops onto canvas)
    plus the `prompt` (API graph); A1111 returns the `parameters` string.
    """
    async with async_conn() as conn:
        raw = None
        for candidate in image_tags.id_candidates(image_id):
            row = (
                await conn.execute(
                    sa.select(t.image_gen_raw.c.raw).where(
                        t.image_gen_raw.c._id == candidate
                    )
                )
            ).first()
            if row is not None:
                raw = row.raw
                break
    if not raw:
        raise HTTPException(status_code=404, detail="No generation data for image")

    # Sanitize on the way out: the stored graph can carry NaN/Infinity (ComfyUI's
    # `is_changed`) which Starlette's strict JSON renderer 500s on.
    source = raw.get("source")
    if source == "comfyui":
        return gen_metadata.sanitize_json(
            {
                "source": "comfyui",
                "workflow": raw.get("workflow"),
                "prompt": raw.get("prompt"),
            }
        )
    if source == "a1111":
        return {"source": "a1111", "parameters": raw.get("parameters")}
    return {"source": source}


@router.get("/{image_id:path}")
async def get_image(image_id: str):
    img = await _find_image_doc(image_id)
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    return img


@router.post("/{image_id:path}/rating")
async def set_image_rating(image_id: str, body: RatingPatch):
    rating = image_tags.normalize_rating(body.rating)
    if rating is None:
        raise HTTPException(
            status_code=422,
            detail="rating must be one of '-', 'general', 'sensitive', 'questionable', 'explicit'",
        )
    rid = await image_tags.set_rating(image_id, rating)
    if rid is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return {"_id": rid, "rating": rating}


@router.post("/{image_id:path}/score")
async def set_image_score(image_id: str, body: ScorePatch):
    """Set the 0-5 quality score (distinct from the content-safety `rating`)."""
    if not (0 <= body.score <= 5):
        raise HTTPException(status_code=422, detail="score must be 0-5")
    rid = await image_tags.set_score(image_id, body.score)
    if rid is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return {"_id": rid, "score": body.score}


@router.post("/{image_id:path}/quarantine")
async def set_image_quarantine(image_id: str, body: QuarantinePatch):
    """Toggle the DB-only quarantine flag (hides from default feed; no disk I/O)."""
    rid = await image_tags.set_quarantine(image_id, bool(body.quarantined))
    if rid is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return {"_id": rid, "quarantined": bool(body.quarantined)}


@router.post("/{image_id:path}/purge")
async def purge_image(image_id: str, body: PurgeBody):
    """Permanently delete the original file from disk + all DB/thumb records.

    Irreversible. A DB-only delete would resurrect on the next scan (the file is
    rediscovered), so purge must remove the file itself. Guarded by `confirm`.
    """
    if not body.confirm:
        raise HTTPException(status_code=400, detail="purge requires confirm=true")
    img = await _find_image_doc(image_id, {"path": 1, "thumb_key": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")

    rid = img["_id"]
    path = img.get("path")
    if path:

        def _unlink():
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

        await anyio.to_thread.run_sync(_unlink)  # type: ignore[attr-defined]

    async with async_tx() as conn:
        # image_tags / image_gen_terms rows cascade via the FK.
        await conn.execute(sa.delete(t.images).where(t.images.c._id == rid))
        await conn.execute(
            sa.delete(t.image_gen_raw).where(t.image_gen_raw.c._id == rid)
        )
    # Cascaded away this image's join rows, so the tag counts moved.
    tag_index.invalidate()

    thumb_key = img.get("thumb_key")
    if thumb_key:
        try:
            await anyio.to_thread.run_sync(  # type: ignore[attr-defined]
                lambda: delete_thumb(thumb_key)
            )
        except Exception:
            pass

    return {"_id": rid, "purged": True}
