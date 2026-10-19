from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
import time
import asyncio

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_tx
from ..database import schema as t
from ._utils import thumb_url, validate_tags
from ..services import (
    characters,
    face_detect,
    image_tags,
    tag_index,
    tag_rename,
    tag_settings,
)

router = APIRouter()


class TagThumbnailSet(BaseModel):
    image_id: str


@router.get("")
async def list_tags(
    include_manual: bool = False,
    include_prompt: bool = False,
    merge_sources: bool = False,
):
    return await tag_index.list_tags(
        include_manual=include_manual,
        include_prompt=include_prompt,
        merge_sources=merge_sources,
    )


class TagSettingsPatch(BaseModel):
    boilerplate: list[str]


@router.get("/settings")
async def get_tag_settings():
    """The boilerplate list (and the built-in defaults, for a reset)."""
    return await tag_settings.get_tag_settings()


@router.post("/settings")
async def set_tag_settings(patch: TagSettingsPatch):
    try:
        return await tag_settings.set_boilerplate(patch.boilerplate)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/samples")
async def tag_samples(
    tags: list[str] = Query(default=[]),
    per: int = Query(default=4, ge=1, le=6),
):
    """Up to `per` distinct images per tag (a stable per-tag pick) for the mosaic
    cards. Bounded (caller passes only the visible tags) and cached."""
    if not tags:
        return {}
    if len(tags) > 200:
        raise HTTPException(status_code=422, detail="too many tags (max 200)")
    # Keyed by what the caller asked for; looked up by the canonical spelling.
    tags = validate_tags(tags, max_count=200)
    results = await asyncio.gather(
        *[tag_index.samples_for_tag(image_tags.canonical_tag(tag), per) for tag in tags]
    )
    return {
        tag: [{**row, "thumb_url": thumb_url(row["_id"])} for row in samples]
        for tag, samples in zip(tags, results)
    }


def _source(source: str) -> str:
    if source not in tag_index.SOURCES:
        raise HTTPException(status_code=422, detail=f"unknown source {source!r}")
    return source


@router.get("/browse")
async def browse_tags(source: str = "all"):
    """The Tags page list: one entry per tag name, its sources merged."""
    return [
        {**row, "thumb_url": thumb_url(row["thumb_image_id"])}
        for row in await tag_index.browse(_source(source))
    ]


@router.get("/characters")
async def list_characters():
    """The characters in the library, most images first, each with its other
    names and cover: what the image view shows as the people in a picture."""
    return [
        {**r, "thumb_url": thumb_url(r.pop("thumb_image_id"))}
        for r in await characters.listing()
    ]


@router.get("/character")
async def character_page(tag: str):
    """A character page, by any of the character's names."""
    base = tag_index.pin_key(validate_tags([tag])[0])
    got = await characters.page(base)
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    cover = got["cover"]
    return {
        **got,
        "thumb_url": thumb_url(cover) if cover else None,
        "best": [{**b, "thumb_url": thumb_url(b["image_id"])} for b in got["best"]],
    }


@router.patch("/character")
async def update_character(tag: str, patch: dict):
    """Set what the user decides for a character: shown name and series, the
    avatar's focus point, a colour, or whether the tag is a character at all.
    An empty value clears a field."""
    try:
        return await characters.update(validate_tags([tag])[0], patch)
    except characters.CharacterError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("/detail")
async def tag_detail(tag: str, source: str = "all"):
    """The Tags page panel for one tag, by name (any spelling or prefix)."""
    base = tag_index.pin_key(validate_tags([tag])[0])
    got = await tag_index.detail(base, _source(source))
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    return {
        **got,
        "thumb_url": thumb_url(got["thumb_image_id"])
        if got["thumb_image_id"]
        else None,
    }


@router.post("/thumbnail/{tag:path}")
async def set_tag_thumbnail(tag: str, body: TagThumbnailSet):
    """Pin a tag's cover. Keyed by the tag's name, so it shows whichever
    sources found the tag; the image must carry it from one of them."""
    tag = tag_index.pin_key(validate_tags([tag])[0])
    image_id = body.image_id
    # A character's avatar may come from an image under any of its names,
    # and is kept under the name its page uses.
    key, names, is_character = await characters.names_of(tag)
    tag = key

    async with async_tx() as conn:
        exists = (
            await conn.execute(
                sa.select(t.images.c._id).where(
                    t.images.c._id == image_id,
                    sa.exists(
                        sa.select(1).where(
                            t.image_tags.c.image_id == t.images.c._id,
                            t.image_tags.c.base.in_(names),
                        )
                    ),
                )
            )
        ).scalar()
        if not exists:
            raise HTTPException(
                status_code=404, detail="Image not found for tag thumbnail"
            )
        stmt = sqlite_insert(t.tag_meta).values(
            tag=tag, thumb_image_id=image_id, updated_at=time.time()
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.tag_meta.c.tag],
            set_={
                "thumb_image_id": stmt.excluded.thumb_image_id,
                "updated_at": stmt.excluded.updated_at,
            },
        )
        await conn.execute(stmt)

    tag_index.invalidate()
    if is_character:
        await face_detect.detect_now(image_id)  # the new avatar crops at once
    return {"tag": tag, "thumb_image_id": image_id}


@router.delete("/thumbnail/{tag:path}")
async def clear_tag_thumbnail(tag: str):
    tag, *_ = await characters.names_of(tag_index.pin_key(validate_tags([tag])[0]))
    async with async_tx() as conn:
        await conn.execute(sa.delete(t.tag_meta).where(t.tag_meta.c.tag == tag))
    tag_index.invalidate()
    return {"tag": tag, "cleared": True}


@router.post("/apply/{image_id}")
async def apply_tags(image_id: str, tags: list[str]):
    cleaned = validate_tags(tags)
    await image_tags.apply_manual(image_id, cleaned)
    return {
        "image_id": image_id,
        "added": [
            image_tags.canonical_tag(image_tags.to_manual(tag)) for tag in cleaned
        ],
    }


@router.post("/remove/{image_id}")
async def remove_tags(image_id: str, tags: list[str]):
    tags = validate_tags(tags)
    await image_tags.remove_tags(image_id, tags)
    return {
        "image_id": image_id,
        "removed": [image_tags.canonical_tag(tag) for tag in tags],
    }


class BulkManualTags(BaseModel):
    image_ids: list[str]
    add: list[str] = []
    remove: list[str] = []


@router.post("/bulk")
async def bulk_manual_tags(body: BulkManualTags):
    """Add/remove manual tags (bare names) on a selection, in one transaction."""
    if not body.image_ids:
        raise HTTPException(status_code=422, detail="image_ids must not be empty")
    if len(body.image_ids) > 10000:
        raise HTTPException(status_code=422, detail="too many images (max 10000)")
    add = validate_tags(body.add) if body.add else []
    remove = validate_tags(body.remove) if body.remove else []
    if not add and not remove:
        raise HTTPException(status_code=422, detail="nothing to add or remove")
    matched, modified = await image_tags.bulk_manual(
        body.image_ids, add=add, remove=remove
    )
    return {"matched": matched, "modified": modified}


class TagRename(BaseModel):
    tag: str
    to: str


@router.post("/rename")
async def rename_tag(body: TagRename):
    """Rename a manual tag, or merge a prompt tag via a stored rule. Merging is
    renaming onto an existing name. AI tags are refused (see tag_rename)."""
    tag, to = validate_tags([body.tag, body.to], max_count=2)
    try:
        return await tag_rename.rename_tag(tag, to)
    except tag_rename.RenameError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/aliases")
async def list_aliases():
    """The prompt-tag merge rules, newest first."""
    return await tag_rename.list_aliases()


@router.delete("/aliases/{from_name:path}")
async def delete_alias(from_name: str):
    res = await tag_rename.delete_alias(from_name)
    if res is None:
        raise HTTPException(status_code=404, detail="No such merge rule")
    return res


@router.post("/ai/{image_id}")
async def ai_tag(image_id: str):
    # Deprecated route retained for convenience.
    # Internal AI tagging is implemented under /ai/*.
    from ..services.ai_jobs import get_ai_job_manager

    jm = get_ai_job_manager()
    job = await jm.enqueue(ids=[image_id])
    return {"job_id": job.id}
