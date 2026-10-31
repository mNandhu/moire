from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import anyio  # type: ignore[import-not-found]
import os

from ..database.db import async_conn, async_tx
from ..services import gen_metadata, gen_raw, image_tags, image_feed
from ..services import tag_index
from ..services import image_delete, thumb_version
from ..services.image_feed import FeedFilter, FeedFilterError
from ..services.image_tags import find_image as _find_image_doc  # type: ignore
from . import image_facets, image_media
from ..models.responses import FeedRow, GroupRow, ImageDetail, documents

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


@router.get("", **documents(list[FeedRow]))
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


SELECT_ALL_CAP = image_feed.SELECT_ALL_CAP


@router.get("/ids")
async def list_image_ids(f: FeedFilter = Depends(feed_filter)):
    """Every image matching the gallery filter, as ids ("Select all"). Same
    filter as the feed, batch grouping aside: these are images, not batches."""
    ids = await image_feed.list_ids(f, limit=SELECT_ALL_CAP + 1)
    return JSONResponse(
        {"ids": ids[:SELECT_ALL_CAP], "truncated": len(ids) > SELECT_ALL_CAP}
    )


# Route order is load-bearing: fixed paths (/models, /stats, /groups...) must
# be registered before the `/{image_id:path}` catch-all below, or it swallows
# them as image ids. Sub-routers are included here, in that order.
router.include_router(image_media.router)
router.include_router(image_facets.router)


@router.get("/groups", **documents(list[GroupRow]))
async def list_groups(
    f: FeedFilter = Depends(feed_filter),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
):
    """Batch-collapsed view of the same feed: images sharing a gen_group_id fold
    into one entry (the newest member is the representative, plus a count).
    Prompt-less / ungrouped images stand alone. Grouping spans page boundaries
    because it's a full aggregation, not a paged-then-grouped pass. group_id is
    honored like any other filter (it narrows the view to that one batch)."""
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
        raw = await gen_raw.raw_for(conn, image_id)
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


@router.get("/{image_id:path}", **documents(ImageDetail))
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
    img = await _find_image_doc(image_id, ("path", "thumb_key"))
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
        keys = await image_delete.delete_rows_async(
            conn, [rid], thumb_keys=[img.get("thumb_key")]
        )
    # Cascaded away this image's join rows, so the tag counts moved.
    tag_index.invalidate()
    await anyio.to_thread.run_sync(image_delete.drop_thumbs, keys)  # type: ignore[attr-defined]

    return {"_id": rid, "purged": True}
