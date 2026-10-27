from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import asyncio

from ..services import thumb_version
from ..services import tag_detail as tag_panel
from ._utils import validate_tags
from ..services import (
    characters,
    danbooru_tags,
    face_detect,
    image_tags,
    tag_descriptions,
    tag_kinds,
    tag_browse,
    tag_covers,
    tag_rename,
    tag_settings,
    tag_views,
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
        await tag_browse.list_tags(
            include_manual=include_manual,
            include_prompt=include_prompt,
            merge_sources=merge_sources,
        )
    )


class TagSettingsPatch(BaseModel):
    boilerplate: list[str]


@router.get("/attire")
async def get_attire_groups():
    """``tag -> attire group`` (headwear, accessories, ...) for every attire
    tag the app knows of: outfit chips are labelled by it, and the attire
    autocomplete ranks by it. Changes with the library's tags."""
    return JSONResponse((await tag_views.tag_maps())[0])


@router.get("/facets")
async def get_tag_facets():
    """``tag -> facet`` (look, outfit, pose, scene, framing) for every listed
    tag that has one, plus the library's own tags that :func:`attire.facet_of`
    places: the image view tints tags by it."""
    return JSONResponse((await tag_views.tag_maps())[1])


@router.get("/groups")
async def get_tag_groups():
    """``tags``: ``tag -> group`` (attire, headwear, posture, ...) for the
    library's tags; ``categories``: each of those groups' top-level category.
    The group pages list a group's tags from it. Built with the attire and
    facet maps, kept until a tag write."""
    return JSONResponse((await tag_views.tag_maps())[2])


class PlaceBody(BaseModel):
    names: list[str] = Field(max_length=1000)


@router.post("/place")
async def place_tags(body: PlaceBody):
    """Where each prompt tag goes on Generate's prompt board, with what the
    tag lists know of it (group, Danbooru posts, the tag an alias stands
    for). ``list``: whether Danbooru's list is in; until it is, no name is
    called unknown. ``fetching``: it is being downloaded."""
    return JSONResponse(await tag_views.place(body.names))


@router.get("/board")
async def board_offers():
    """``section -> [[tag, posts], ...]``: what each prompt-board section can
    suggest, the library's tags among them. Changes with the library's tags
    and when Danbooru's list arrives."""
    return JSONResponse(await tag_views.board_offers())


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


@router.get("/descriptions")
async def descriptions():
    """``tag -> one-sentence description`` for the tagger's general tags (a
    shipped file), and their Danbooru aliases when that list is already in
    (this never starts its download: the prompt board does)."""
    tags = await danbooru_tags.load_present()
    return JSONResponse(tag_descriptions.served(tags.aliases))


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
        *[tag_covers.samples_for_tag(tag_kinds.canonical_tag(tag), per) for tag in tags]
    )
    thumbs = await thumb_version.urls(row["_id"] for got in results for row in got)
    return {
        tag: [{**row, "thumb_url": thumbs[row["_id"]]} for row in samples]
        for tag, samples in zip(tags, results)
    }


def _base(tag: str) -> str:
    """The tag a route names (query or path), as its covers and pages key
    it: validated, any source prefix dropped."""
    return tag_covers.pin_key(validate_tags([tag])[0])


def _source(source: str) -> str:
    if source not in tag_browse.SOURCES:
        raise HTTPException(status_code=422, detail=f"unknown source {source!r}")
    return source


@router.get("/browse")
async def browse_tags(source: str = "all"):
    """The Tags page list: one entry per tag name, its sources merged."""
    rows = await tag_browse.browse(_source(source))
    focus = await tag_covers.all_focus()
    thumbs = await thumb_version.urls(row["thumb_image_id"] for row in rows)
    return JSONResponse(
        [
            {
                **row,
                "thumb_url": thumbs.get(row["thumb_image_id"]),
                "focus": tag_covers.for_cover(
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
    rows = await characters.listing()
    thumbs = await thumb_version.urls(r["thumb_image_id"] for r in rows)
    return [{**r, "thumb_url": thumbs.get(r["thumb_image_id"] or "")} for r in rows]


@router.get("/character")
async def character_page(base: str = Depends(_base)):
    """A character page, by any of the character's names. Any other tag gets
    the same page (the tag page), its focus being the cover's framing."""
    got = await characters.page(base)
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    cover = got["cover"]
    if got["category"] != "character" and not got.get("made"):
        # A plain tag's page: its cover's framing lives in tag_covers, set
        # for the image that is the cover.
        got["focus"] = await tag_covers.get_focus(got["tag"], cover)
    thumbs = await thumb_version.urls([cover, *(b["image_id"] for b in got["best"])])
    return {
        **got,
        "thumb_url": thumbs.get(cover or ""),
        "best": [{**b, "thumb_url": thumbs[b["image_id"]]} for b in got["best"]],
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
    tag = _base(raw).lower()
    patch = {k: body[k] for k in ("name", "series", "color") if k in body}
    try:
        return await characters.create(tag, patch)
    except characters.Taken as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except characters.CharacterError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.delete("/character")
async def delete_character(base: str = Depends(_base)):
    """Forget a character made by hand, while no image has its tag."""
    if not await characters.remove_made(base.lower()):
        raise HTTPException(
            status_code=409, detail="Only a character with no images can be deleted"
        )
    return {"ok": True}


@router.get("/detail")
async def tag_detail(source: str = "all", base: str = Depends(_base)):
    """The Tags page panel for one tag, by name (any spelling or prefix)."""
    got = await tag_panel.detail(base, _source(source))
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    cover = await tag_views.cover_of(base, got["thumb_image_id"])
    thumbs = await thumb_version.urls([got["thumb_image_id"], cover])
    return {
        **got,
        "thumb_url": thumbs.get(got["thumb_image_id"] or ""),
        "cover_image_id": cover,
        "cover_url": thumbs.get(cover or ""),
        "aspect": await tag_covers.aspect_of(cover),
        "focus": await tag_covers.get_focus(base, cover),
    }


@router.put("/focus")
async def set_tag_focus(body: dict, base: str = Depends(_base)):
    """Centre a tag's cover on a point (``focus_x``, ``focus_y``, 0..1);
    empty values clear it. The point belongs to the cover it was set on."""
    try:
        point = tag_covers.clean(body.get("focus_x"), body.get("focus_y"))
    except tag_covers.FocusError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    got = await tag_panel.detail(base, "all")
    if got is None:
        raise HTTPException(status_code=404, detail="No image has this tag")
    cover = await tag_views.cover_of(base, got["thumb_image_id"])
    return {"tag": base, "focus": await tag_covers.put_focus(base, point, cover)}


@router.post("/thumbnail/{tag:path}")
async def set_tag_thumbnail(body: TagThumbnailSet, base: str = Depends(_base)):
    """Pin a tag's cover. Keyed by the tag's name, so it shows whichever
    sources found the tag; the image must carry it from one of them."""
    # A character's avatar may come from an image under any of its names,
    # and is kept under the name its page uses.
    key, names, is_character = await characters.names_of(base)
    tag = key
    image_id = await tag_covers.set_pin(tag, names, body.image_id)
    if image_id is None:
        raise HTTPException(status_code=404, detail="Image not found for tag thumbnail")
    if is_character:
        await face_detect.detect_now(image_id)  # the new avatar crops at once
    return {"tag": tag, "thumb_image_id": image_id}


@router.delete("/thumbnail/{tag:path}")
async def clear_tag_thumbnail(base: str = Depends(_base)):
    tag, *_ = await characters.names_of(base)
    await tag_covers.clear_pin(tag)
    return {"tag": tag, "cleared": True}


@router.post("/apply/{image_id:path}")
async def apply_tags(image_id: str, tags: list[str]):
    cleaned = validate_tags(tags)
    await image_tags.apply_manual(image_id, cleaned)
    return {
        "image_id": image_id,
        "added": [tag_kinds.canonical_tag(tag_kinds.to_manual(tag)) for tag in cleaned],
    }


@router.post("/remove/{image_id:path}")
async def remove_tags(image_id: str, tags: list[str]):
    tags = validate_tags(tags)
    await image_tags.remove_tags(image_id, tags)
    return {
        "image_id": image_id,
        "removed": [tag_kinds.canonical_tag(tag) for tag in tags],
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


# Merge and split rules. `/aliases` is their old name, kept for old clients.
@router.get("/rules")
@router.get("/aliases", include_in_schema=False)
async def list_rules():
    """The prompt-tag merge and split rules, newest first."""
    return await tag_rename.list_rules()


class TagRule(BaseModel):
    from_: str = Field(alias="from")
    to: list[str] = Field(min_length=1, max_length=8)


class TagRules(BaseModel):
    # Every suggestion at once must fit: a library rarely has this many.
    rules: list[TagRule] = Field(max_length=50_000)


@router.post("/rules")
@router.post("/aliases", include_in_schema=False)
async def add_rules(body: TagRules):
    """Store several merge / split rules at once (accepted suggestions)."""
    return await tag_rename.add_rules([(r.from_, r.to) for r in body.rules])


@router.get("/merge-suggestions")
async def merge_suggestions():
    """Prompt tags Danbooru names otherwise, as rules to accept (tag_canon)."""
    return JSONResponse(await tag_rename.merge_suggestions())


@router.delete("/rules/{from_name:path}")
@router.delete("/aliases/{from_name:path}", include_in_schema=False)
async def delete_rule(from_name: str):
    res = await tag_rename.delete_rule(from_name)
    if res is None:
        raise HTTPException(status_code=404, detail="No such merge rule")
    return res
