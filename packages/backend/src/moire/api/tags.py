from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import time
import asyncio

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from ._utils import thumb_url, validate_tags
from ..services import (
    attire,
    characters,
    danbooru_tags,
    face_detect,
    image_tags,
    prompt_board,
    tag_categories,
    tag_focus,
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
    # Plain JSON rows: JSONResponse skips jsonable_encoder's walk.
    return JSONResponse(
        await tag_index.list_tags(
            include_manual=include_manual,
            include_prompt=include_prompt,
            merge_sources=merge_sources,
        )
    )


class TagSettingsPatch(BaseModel):
    boilerplate: list[str]


_maps_lock = asyncio.Lock()


async def _tag_maps() -> tuple[dict[str, str], dict[str, str]]:
    """The attire and facet maps over the tagger's vocabulary plus every tag in
    the library (free-form prompt tags like ``pastel_pink_dolphin_shorts``
    included). Classifying ~10k names takes tens of milliseconds, so they are
    built together in a thread and kept until a tag write or a new
    vocabulary."""
    async with _maps_lock:
        gen = tag_index.current_generation()
        vocab = await tag_categories.load()
        cached = tag_index.read_derived("tag-maps")
        if cached is not None and cached[0] is vocab.general:
            return cached[1], cached[2]
        async with async_conn() as conn:
            bases = (
                await conn.execute(sa.select(t.image_tags.c.base).distinct())
            ).scalars()
            names = list(dict.fromkeys([*vocab.general, *(b for b in bases if b)]))
        attire_map, facet_map = await asyncio.to_thread(
            lambda: (attire.attire_tags(names), attire.facets(names))
        )
        tag_index.store_derived("tag-maps", gen, (vocab.general, attire_map, facet_map))
        return attire_map, facet_map


@router.get("/attire")
async def get_attire_groups():
    """``tag -> attire group`` (headwear, accessories, ...) for every attire
    tag the app knows of: outfit chips are labelled by it, and the attire
    autocomplete ranks by it. Changes with the library's tags."""
    return JSONResponse((await _tag_maps())[0])


@router.get("/facets")
async def get_tag_facets():
    """``tag -> facet`` (look, outfit, pose, scene, framing) for every listed
    tag that has one, plus the library's own tags that :func:`attire.facet_of`
    places: the image view tints tags by it."""
    return JSONResponse((await _tag_maps())[1])


class PlaceBody(BaseModel):
    names: list[str] = Field(max_length=1000)


@router.post("/place")
async def place_tags(body: PlaceBody):
    """Where each prompt tag goes on Generate's prompt board, with what the
    tag lists know of it (group, Danbooru posts, the tag an alias stands
    for). ``list``: whether Danbooru's list is in; until it is, no name is
    called unknown. ``fetching``: it is being downloaded."""
    tags = await danbooru_tags.load()
    vocab = await tag_categories.load()
    placed = await asyncio.to_thread(
        prompt_board.place_all, body.names, tags, vocab.names
    )
    return JSONResponse(
        {"names": placed, "list": bool(tags.tags), "fetching": danbooru_tags.fetching()}
    )


@router.get("/board")
async def board_offers():
    """``section -> [[tag, posts], ...]``: what each prompt-board section can
    suggest, the library's tags among them. Changes with the library's tags
    and when Danbooru's list arrives."""
    gen = tag_index.current_generation()
    tags = await danbooru_tags.load()
    vocab = await tag_categories.load()
    cached = tag_index.read_derived("board-offers")
    if cached is not None and cached[0] is tags and cached[1] is vocab:
        return JSONResponse(cached[2])
    async with async_conn() as conn:
        bases = [
            b
            for b in (
                await conn.execute(sa.select(t.image_tags.c.base).distinct())
            ).scalars()
            if b
        ]
    out = await asyncio.to_thread(
        prompt_board.offers, vocab.general, tags, vocab.names, bases
    )
    tag_index.store_derived("board-offers", gen, (tags, vocab, out))
    return JSONResponse(out)


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
    rows = await tag_index.browse(_source(source))
    focus = await tag_focus.all_focus()
    return JSONResponse(
        [
            {
                **row,
                "thumb_url": thumb_url(row["thumb_image_id"]),
                "focus": tag_focus.for_cover(
                    focus.get(row["tag"]), row["thumb_image_id"]
                ),
            }
            for row in rows
        ]
    )


@router.get("/characters")
async def list_characters():
    """The characters in the library, most images first, each with its other
    names and cover: what the image view shows as the people in a picture.
    ``thumb_image_id`` lets it tell whether the open image is the avatar."""
    return [
        {
            **r,
            "thumb_url": thumb_url(r["thumb_image_id"])
            if r["thumb_image_id"]
            else None,
        }
        for r in await characters.listing()
    ]


@router.get("/character")
async def character_page(tag: str):
    """A character page, by any of the character's names. Any other tag gets
    the same page (the tag page), its focus being the cover's framing."""
    base = tag_index.pin_key(validate_tags([tag])[0])
    got = await characters.page(base)
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    cover = got["cover"]
    if got["category"] != "character" and not got.get("made"):
        # A plain tag's page: its cover's framing lives in tag_focus, set
        # for the image that is the cover.
        got["focus"] = await tag_focus.get(got["tag"], cover)
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


@router.post("/characters")
async def create_character(body: dict):
    """Make a character by hand: a tag (the tagger's name for them, or any),
    with an optional name, series and colour. It has a page and a recipe
    before any image has the tag."""
    raw = str(body.get("tag") or "").strip()
    if not raw:
        raise HTTPException(status_code=422, detail="tag is required")
    # Lower case, as the tagger writes characters, so images match it.
    tag = tag_index.pin_key(validate_tags([raw])[0]).lower()
    patch = {k: body[k] for k in ("name", "series", "color") if k in body}
    try:
        return await characters.create(tag, patch)
    except characters.Taken as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except characters.CharacterError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.delete("/character")
async def delete_character(tag: str):
    """Forget a character made by hand, while no image has its tag."""
    if not await characters.remove_made(
        tag_index.pin_key(validate_tags([tag])[0]).lower()
    ):
        raise HTTPException(
            status_code=409, detail="Only a character with no images can be deleted"
        )
    return {"ok": True}


@router.get("/detail")
async def tag_detail(tag: str, source: str = "all"):
    """The Tags page panel for one tag, by name (any spelling or prefix)."""
    base = tag_index.pin_key(validate_tags([tag])[0])
    got = await tag_index.detail(base, _source(source))
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    cover = await _cover_of(base, got["thumb_image_id"])
    return {
        **got,
        "thumb_url": thumb_url(got["thumb_image_id"])
        if got["thumb_image_id"]
        else None,
        "cover_image_id": cover,
        "cover_url": thumb_url(cover) if cover else None,
        "aspect": await tag_focus.aspect_of(cover),
        "focus": await tag_focus.get(base, cover),
    }


async def _cover_of(base: str, pinned: str | None) -> str | None:
    """A tag's cover: the pin, else what its mosaic leads with."""
    if pinned:
        return pinned
    lead = await tag_index.samples_for_tag(f"{image_tags.ANY_PREFIX}{base}", 1)
    return lead[0]["_id"] if lead else None


@router.put("/focus")
async def set_tag_focus(tag: str, body: dict):
    """Centre a tag's cover on a point (``focus_x``, ``focus_y``, 0..1);
    empty values clear it. The point belongs to the cover it was set on."""
    base = tag_index.pin_key(validate_tags([tag])[0])
    try:
        point = tag_focus.clean(body.get("focus_x"), body.get("focus_y"))
    except tag_focus.FocusError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    got = await tag_index.detail(base, "all")
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    cover = await _cover_of(base, got["thumb_image_id"])
    return {"tag": base, "focus": await tag_focus.put(base, point, cover)}


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


@router.post("/apply/{image_id:path}")
async def apply_tags(image_id: str, tags: list[str]):
    cleaned = validate_tags(tags)
    await image_tags.apply_manual(image_id, cleaned)
    return {
        "image_id": image_id,
        "added": [
            image_tags.canonical_tag(image_tags.to_manual(tag)) for tag in cleaned
        ],
    }


@router.post("/remove/{image_id:path}")
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


@router.post("/ai/{image_id:path}")
async def ai_tag(image_id: str):
    # Deprecated route retained for convenience.
    # Internal AI tagging is implemented under /ai/*.
    from ..services.ai_jobs import get_ai_job_manager

    jm = get_ai_job_manager()
    job = await jm.enqueue(ids=[image_id])
    return {"job_id": job.id}
