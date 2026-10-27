"""Saved outfits, the Default outfit and cover choices."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ...services import outfits, tag_categories, thumb_version

router = APIRouter()


# -- Outfits ----------------------------------------------------------------------


class HiddenIn(BaseModel):
    character: str = Field(..., min_length=1)
    hidden: bool


async def _thumbs(found: Any) -> Any:
    """An outfit (or a list of them, or cover choices) with its cover's
    ``thumb_url``."""
    await thumb_version.attach(found)
    return found


@router.get("/outfits")
async def list_outfits(character: str | None = None):
    """Every saved outfit, or ``character``'s list (own and shared)."""
    try:
        return await _thumbs(await outfits.listing(character))
    except outfits.OutfitError as e:
        raise HTTPException(status_code=404, detail="Character not found") from e


@router.get("/outfits/default")
async def default_outfit(character: str):
    o = await outfits.default(character)
    if o is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return await _thumbs(o)


@router.put("/outfits/default")
async def put_default_outfit(character: str, body: dict[str, Any]):
    """Edit ``character``'s Default: name, dropped / added tags, image_id;
    ``reset`` clears the name and tag edits."""
    try:
        o = await outfits.update_default(character, body)
    except outfits.OutfitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if o is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return await _thumbs(o)


@router.get("/outfits/tag-info")
async def outfit_tag_info(tags: list[str] = Query(default_factory=list)):
    """Each tag's attire group and whether the tagger can check it (its
    vocabulary), for tags added by hand in the outfit dialog."""
    vocab = await tag_categories.load()
    return outfits.tag_info(outfits.clean_tags(tags), vocab.general)


@router.get("/outfits/covers")
async def outfit_covers(
    character: str, outfit: str = "", tags: list[str] = Query(default_factory=list)
):
    """Images ``character`` wears ``outfit`` in ("default" for their usual
    clothes; none: these ``tags``), most of it first: the cover picker's
    choices."""
    found = await outfits.covers(character, outfit or None, tags)
    if found is None:
        raise HTTPException(status_code=404, detail="Character or outfit not found")
    return await _thumbs(found)


@router.get("/outfits/worn")
async def outfits_worn(image: str, characters: list[str] = Query(default_factory=list)):
    """The outfits ``image`` wears, for the ``characters`` in it: the
    viewer's Wearing list."""
    found = await outfits.worn(image, characters)
    if found is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return await _thumbs(found)


@router.get("/outfits/prefill")
async def outfit_prefill(image: str, character: str):
    """The save dialog's tags for ``image`` worn by ``character``."""
    o = await outfits.prefill(image, character)
    if o is None:
        raise HTTPException(status_code=404, detail="Image or character not found")
    return o


@router.post("/outfits")
async def create_outfit(body: dict[str, Any]):
    try:
        return await _thumbs(await outfits.create(body))
    except outfits.OutfitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/outfits/{outfit_id}")
async def update_outfit(outfit_id: str, body: dict[str, Any]):
    try:
        o = await outfits.update(outfit_id, body)
    except outfits.OutfitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if o is None:
        raise HTTPException(status_code=404, detail="Outfit not found")
    return await _thumbs(o)


@router.delete("/outfits/{outfit_id}")
async def delete_outfit(outfit_id: str):
    if not await outfits.delete(outfit_id):
        raise HTTPException(status_code=404, detail="Outfit not found")
    return {"ok": True}


@router.put("/outfits/{outfit_id}/hidden")
async def hide_outfit(outfit_id: str, body: HiddenIn):
    try:
        found = await outfits.set_hidden(outfit_id, body.character, body.hidden)
    except outfits.OutfitError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not found:
        raise HTTPException(status_code=404, detail="Outfit not found")
    return {"ok": True}
