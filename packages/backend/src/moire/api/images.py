from fastapi import APIRouter, Depends, HTTPException, Query, Request, Header, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Literal
import logging
import mimetypes
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import anyio  # type: ignore[import-not-found]
import os
from pathlib import Path

import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from ..services.storage_fs import delete_thumb, small_thumb_path, thumb_path
from ..services import gen_metadata, image_shapes, image_tags, image_feed, tag_index
from ..services import thumb_version
from ..services.image_feed import FeedFilter, FeedFilterError
from ..services.image_tags import find_image as _find_image_doc  # type: ignore

logger = logging.getLogger(__name__)


router = APIRouter()


class RatingPatch(BaseModel):
    rating: str


class ScorePatch(BaseModel):
    score: int


class QuarantinePatch(BaseModel):
    quarantined: bool


class PurgeBody(BaseModel):
    confirm: bool = False


async def _attach_thumb_urls(items: list[dict]) -> None:
    """Replace each row's thumb_key with its versioned streaming thumb route."""
    await thumb_version.urls_for_rows(items)
    for it in items:
        it.pop("thumb_key", None)


def feed_filter(
    tags: list[str] | None = Query(default=None),
    logic: str = Query(default="and"),
    library_id: str | None = Query(default=None),
    no_tags: int | None = Query(default=None, alias="no_tags"),
    no_ai_tags: int | None = Query(default=None, alias="no_ai_tags"),
    ai_tagged: int | None = Query(default=None),
    quarantined: int | None = Query(default=None),
    needs_mapping: int | None = Query(default=None),
    pterms: list[str] | None = Query(default=None),
    plogic: str = Query(default="and"),
    model: list[str] | None = Query(default=None),
    lora: list[str] | None = Query(default=None),
    embedding: list[str] | None = Query(default=None),
    shape: list[str] | None = Query(default=None),
    min_w: int | None = Query(default=None, ge=0),
    max_w: int | None = Query(default=None, ge=0),
    min_h: int | None = Query(default=None, ge=0),
    max_h: int | None = Query(default=None, ge=0),
    group_id: str | None = Query(default=None),
    workflow: str | None = Query(default=None, max_length=256),
    workflow_sig: str | None = Query(default=None, max_length=256),
    outfit: list[str] | None = Query(default=None),
    sort: str = Query(default="newest"),
) -> FeedFilter:
    """The gallery filter from the query string: one parameter set for every
    route that answers "which images match", so they can't drift."""
    try:
        return FeedFilter(
            tags=tags,
            logic=logic,
            library_id=library_id,
            no_tags=no_tags,
            no_ai_tags=no_ai_tags,
            ai_tagged=ai_tagged,
            quarantined=quarantined,
            needs_mapping=needs_mapping,
            pterms=pterms,
            plogic=plogic,
            model=model,
            lora=lora,
            embedding=embedding,
            shape=shape,
            min_w=min_w,
            max_w=max_w,
            min_h=min_h,
            max_h=max_h,
            group_id=group_id,
            workflow_id=workflow,
            workflow_sig=workflow_sig,
            outfit=outfit,
            sort=sort,
        )
    except FeedFilterError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("")
async def list_images(
    f: FeedFilter = Depends(feed_filter),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    cursor: str | None = Query(default=None),
):
    if cursor and len(cursor) > 1024:
        raise HTTPException(status_code=422, detail="cursor too long")

    headers: dict[str, str] = {}
    if not cursor and offset:
        headers["X-Moire-Warn"] = (
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
        headers["X-Next-Cursor"] = next_cursor
    await _attach_thumb_urls(items)
    # Rows are plain JSON values already: skip jsonable_encoder's walk, which
    # cost more than the query on a 1000-row page.
    return JSONResponse(items, headers=headers)


# The most "Select all" picks at once; more is a sign of a mistake.
SELECT_ALL_CAP = 20_000


@router.get("/ids")
async def list_image_ids(f: FeedFilter = Depends(feed_filter)):
    """Every image matching the gallery filter, as ids ("Select all"). Same
    filter as the feed, batch grouping aside: these are images, not batches."""
    ids = await image_feed.list_ids(f, limit=SELECT_ALL_CAP + 1)
    return JSONResponse(
        {"ids": ids[:SELECT_ALL_CAP], "truncated": len(ids) > SELECT_ALL_CAP}
    )


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


ThumbSize = Literal["small"]


# Making small copies is CPU work: a cold page of previews shouldn't take
# every worker thread the other routes share.
_SMALL_LIMIT = anyio.CapacityLimiter(4)

_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
# A URL without its version (one built before URLs had one) is checked again
# on every use: its file may have been rebuilt under it.
_REVALIDATE = {"Cache-Control": "no-cache"}


def _etag_matches(if_none_match: str | None, etag: str) -> bool:
    """`If-None-Match` names this ETag (or `*`). Weak tags compare equal."""
    if not if_none_match:
        return False
    tags = [x.strip().removeprefix("W/") for x in if_none_match.split(",")]
    return "*" in tags or etag.removeprefix("W/") in tags


def _media_type(path: str) -> str:
    return "image/webp" if path.endswith(".webp") else "image/jpeg"


async def _thumb_file(key: str, size: ThumbSize | None) -> tuple[Path | None, bool]:
    """The file to serve, and whether it is the one asked for (cacheable)."""
    if size == "small":
        try:
            path = await anyio.to_thread.run_sync(
                lambda: small_thumb_path(key), limiter=_SMALL_LIMIT
            )
            return path, True
        except OSError:
            # Couldn't write the copy: the thumbnail stands in, uncached, so
            # the small one is asked for again.
            logger.warning("small thumbnail failed for %s", key, exc_info=True)
            path = await anyio.to_thread.run_sync(lambda: thumb_path(key))
            return path, False
    return await anyio.to_thread.run_sync(lambda: thumb_path(key)), True


@router.get("/{image_id:path}/thumb")
async def get_image_thumb(
    image_id: str,
    request: Request,
    size: ThumbSize | None = None,
    v: str | None = Query(default=None, max_length=64),
):
    """The image's thumbnail; `size=small` for a copy ~256px on its short side
    (made on first ask), for previews shown postage-stamp size. `v` is the
    URL's version (`thumb_version`): with it the response is kept for a year,
    without it the browser asks again (a 304 while the file is unchanged)."""
    img = await _find_image_doc(image_id, {"thumb_key": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    thumb_key = img.get("thumb_key")
    if not thumb_key:
        raise HTTPException(status_code=404, detail="Thumbnail not available")

    path, cacheable = await _thumb_file(thumb_key, size)
    if path is None:
        raise HTTPException(status_code=404, detail="Thumbnail not found on disk")
    cache = _IMMUTABLE if cacheable and v else _REVALIDATE
    try:
        st = await anyio.to_thread.run_sync(lambda: os.stat(path))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Thumbnail not found on disk")
    # FileResponse handles ETag/Content-Length/sendfile natively; given the
    # stat, its ETag is there to answer a revalidation with.
    resp = FileResponse(
        path, media_type=_media_type(path.name), headers=cache, stat_result=st
    )
    etag = resp.headers["etag"]
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers={"ETag": etag, **cache})
    return resp


@router.head("/{image_id:path}/thumb")
async def head_image_thumb(
    image_id: str,
    size: ThumbSize | None = None,
    v: str | None = Query(default=None, max_length=64),
):
    img = await _find_image_doc(image_id, {"thumb_key": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    thumb_key = img.get("thumb_key", "") or ""
    exists = thumb_key and await anyio.to_thread.run_sync(lambda: thumb_path(thumb_key))
    if not exists:
        raise HTTPException(status_code=404, detail="Thumbnail not found on disk")
    # A small copy is always WebP; it may not be made yet, so no length.
    media_type = "image/webp" if size == "small" else _media_type(thumb_key)
    headers = {"Accept-Ranges": "bytes"}
    return Response(status_code=200, headers=headers, media_type=media_type)


@router.get("/{image_id:path}/thumb-url")
async def get_thumb_url(image_id: str):
    """The image's versioned thumbnail URL, for a page holding only its id."""
    img = await _find_image_doc(image_id, {"_id": 1, "thumb_key": 1})
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    row = {"_id": img["_id"], "thumb_key": img.get("thumb_key")}
    await thumb_version.urls_for_rows([row])
    return {"thumb_url": row["thumb_url"]}


@router.get("/models")
async def list_models(library_id: str | None = Query(default=None)):
    """Distinct extracted checkpoints with image counts, for the model filter
    dropdown. Sorted by frequency."""
    stmt = (
        sa.select(t.images.c.gen_model, sa.func.count().label("count"))
        .where(t.images.c.gen_model.isnot(None), image_tags.not_quarantined())
        .group_by(t.images.c.gen_model)
        .order_by(sa.func.count().desc())
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [{"model": r.gen_model, "count": r.count} for r in rows]


@router.get("/loras")
async def list_loras(library_id: str | None = Query(default=None)):
    """Distinct loras with image counts, for the LoRA filter dropdown. Sorted
    by frequency."""
    stmt = (
        sa.select(t.image_loras.c.name, sa.func.count().label("count"))
        .join(t.images, t.images.c._id == t.image_loras.c.image_id)
        .where(image_tags.not_quarantined())
        .group_by(t.image_loras.c.name)
        .order_by(sa.func.count().desc(), t.image_loras.c.name)
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [{"name": r.name, "count": r.count} for r in rows]


@router.get("/embeddings")
async def list_embeddings(library_id: str | None = Query(default=None)):
    """Distinct embeddings with image counts (either prompt side), for the
    embedding filter dropdown. Sorted by frequency."""
    e = t.image_embeddings
    count = sa.func.count(sa.distinct(e.c.image_id))
    stmt = (
        sa.select(e.c.name, count.label("count"))
        .join(t.images, t.images.c._id == e.c.image_id)
        .where(image_tags.not_quarantined())
        .group_by(e.c.name)
        .order_by(count.desc(), e.c.name)
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [{"name": r.name, "count": r.count} for r in rows]


@router.get("/sizes")
async def list_sizes(library_id: str | None = Query(default=None)):
    """Every size preset with how many images have that shape, for the Size
    filter. Presets come in order (portrait to landscape), empty ones too."""
    stmt = (
        sa.select(t.images.c.width, t.images.c.height, sa.func.count().label("count"))
        .where(image_tags.not_quarantined())
        .group_by(t.images.c.width, t.images.c.height)
    )
    if library_id:
        stmt = stmt.where(t.images.c.library_id == library_id)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    counts: dict[str, int] = {}
    for r in rows:
        name = image_shapes.shape_of(r.width, r.height)
        if name:
            counts[name] = counts.get(name, 0) + r.count
    return [
        {
            "shape": s.name,
            "width": s.width,
            "height": s.height,
            "orientation": s.orientation,
            "count": counts.get(s.name, 0),
        }
        for s in image_shapes.SHAPES
    ]


# Activity is counted per 15-minute slot, then each slot is placed on a local
# day in Python. Every UTC offset in use is a multiple of 15 minutes, so this
# is exact for any zone, DST changes included, which one fixed offset for the
# whole year was not.
_SLOT = 900


@router.get("/stats")
async def image_stats(
    days: int = Query(default=371, ge=1, le=3660),
    tz: str = Query(default="UTC", max_length=64),
    tz_offset: int | None = Query(default=None, ge=-14 * 60, le=14 * 60),
):
    """Overview numbers: images per local calendar day over the last ``days``
    (by file mtime, the generation-time proxy the feed sorts on), and the
    quarantine backlog. ``tz`` is the viewer's IANA zone ("Asia/Kolkata"), so
    days break at their midnight on each date. A zone this server doesn't know
    falls back to ``tz_offset`` (minutes east of UTC, the viewer's current
    offset): right except across DST, better than no chart. Days with no
    images are omitted."""
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        if tz_offset is None:
            raise HTTPException(status_code=422, detail="unknown time zone")
        zone = timezone(timedelta(minutes=tz_offset))
    # The feed's own sort expression, so the range walks ix_images_recent.
    when = image_feed.SORT_KEY
    slot = sa.cast(when / _SLOT, sa.Integer)
    since = time.time() - days * 86400
    activity = (
        sa.select(slot.label("slot"), sa.func.count().label("count"))
        .where(when >= since)
        .group_by(slot)
    )
    quarantined = sa.select(sa.func.count()).where(t.images.c.quarantined.is_(True))
    async with async_conn() as conn:
        rows = (await conn.execute(activity)).fetchall()
        q = (await conn.execute(quarantined)).scalar_one()
    per_day: dict[str, int] = {}
    for r in rows:
        day = datetime.fromtimestamp(r.slot * _SLOT, zone).date().isoformat()
        per_day[day] = per_day.get(day, 0) + r.count
    return {
        "activity": [{"day": d, "count": n} for d, n in sorted(per_day.items())],
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
    ai_tagged: int | None = Query(default=None),
    quarantined: int | None = Query(default=None),
    needs_mapping: int | None = Query(default=None),
    pterms: list[str] | None = Query(default=None),
    plogic: str = Query(default="and"),
    model: list[str] | None = Query(default=None),
    lora: list[str] | None = Query(default=None),
    embedding: list[str] | None = Query(default=None),
    shape: list[str] | None = Query(default=None),
    min_w: int | None = Query(default=None, ge=0),
    max_w: int | None = Query(default=None, ge=0),
    min_h: int | None = Query(default=None, ge=0),
    max_h: int | None = Query(default=None, ge=0),
    workflow: str | None = Query(default=None, max_length=256),
    workflow_sig: str | None = Query(default=None, max_length=256),
    outfit: list[str] | None = Query(default=None),
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
            ai_tagged=ai_tagged,
            quarantined=quarantined,
            needs_mapping=needs_mapping,
            pterms=pterms,
            plogic=plogic,
            model=model,
            lora=lora,
            embedding=embedding,
            shape=shape,
            min_w=min_w,
            max_w=max_w,
            min_h=min_h,
            max_h=max_h,
            workflow_id=workflow,
            workflow_sig=workflow_sig,
            outfit=outfit,
            sort=sort,
        )
    except FeedFilterError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    out = await image_feed.list_groups(f, offset=offset, limit=limit)
    await _attach_thumb_urls(out)
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
    await thumb_version.urls_for_rows([img])
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
