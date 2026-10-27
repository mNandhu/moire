"""Character names and recipes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ...services import recipes, tag_categories

router = APIRouter()


# -- Character recipes -----------------------------------------------------------


@router.get("/character-names")
async def character_names():
    """Every character the AI tagger knows by name, in or out of the library:
    for prompt autocomplete and making a character from scratch."""
    return sorted((await tag_categories.load()).names)


@router.get("/recipes/{tag}")
async def get_recipe(tag: str):
    r = await recipes.recipe(tag)
    if r is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return r


@router.put("/recipes/{tag}")
async def put_recipe(tag: str, patch: dict[str, Any]):
    try:
        r = await recipes.update(tag, patch)
    except recipes.RecipeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if r is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return r
