"""Derived views over every tag in the library: the attire and facet maps,
the library's tag groups, its tag names and the prompt board's offers.

Each is costly to build and changes only with a tag write (or a new
vocabulary / Danbooru list), so each is kept in :mod:`services.tag_index`'s
derived cache: the generation is captured before reading, and a write landing
mid-build discards the result.
"""

from __future__ import annotations

import asyncio

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import (
    attire,
    danbooru_tags,
    prompt_board,
    tag_categories,
    tag_index,
)

_maps_lock = asyncio.Lock()


async def library_bases() -> list[str]:
    """Every tag name the library's images carry, prefix dropped. Kept until
    the next tag write."""
    gen = tag_index.current_generation()
    cached = tag_index.read_derived("library-bases")
    if cached is not None:
        return cached
    async with async_conn() as conn:
        bases = [
            b
            for b in (
                await conn.execute(sa.select(t.image_tags.c.base).distinct())
            ).scalars()
            if b
        ]
    tag_index.store_derived("library-bases", gen, bases)
    return bases


async def tag_maps() -> tuple[dict[str, str], dict[str, str], dict]:
    """The attire and facet maps (and the library's tag groups) over the tagger's vocabulary plus every tag in
    the library (free-form prompt tags like ``pastel_pink_dolphin_shorts``
    included). Classifying ~10k names takes tens of milliseconds, so they are
    built together in a thread and kept until a tag write or a new
    vocabulary."""
    async with _maps_lock:
        gen = tag_index.current_generation()
        vocab = await tag_categories.load()
        cached = tag_index.read_derived("tag-maps")
        if cached is not None and cached[0] is vocab.general:
            return cached[1], cached[2], cached[3]
        library = await library_bases()
        names = list(dict.fromkeys([*vocab.general, *library]))
        attire_map, facet_map, groups = await asyncio.to_thread(
            lambda: (
                attire.attire_tags(names),
                attire.facets(names),
                attire.library_groups(library),
            )
        )
        tag_index.store_derived(
            "tag-maps", gen, (vocab.general, attire_map, facet_map, groups)
        )
        return attire_map, facet_map, groups


async def place(names: list[str]) -> dict:
    """Where each prompt tag goes on Generate's prompt board, with what the
    tag lists know of it. ``list``: whether Danbooru's list is in;
    ``fetching``: it is being downloaded."""
    tags = await danbooru_tags.load()
    vocab = await tag_categories.load()
    library = frozenset(await library_bases())
    placed = await asyncio.to_thread(
        prompt_board.place_all, names, tags, vocab.names, library
    )
    return {
        "names": placed,
        "list": bool(tags.tags),
        "fetching": danbooru_tags.fetching(),
    }


async def board_offers() -> dict[str, list[list]]:
    """``section -> [[tag, posts], ...]``: what each prompt-board section can
    suggest, the library's tags among them. Kept until a tag write or until
    Danbooru's list or the vocabulary changes."""
    gen = tag_index.current_generation()
    tags = await danbooru_tags.load()
    vocab = await tag_categories.load()
    cached = tag_index.read_derived("board-offers")
    if cached is not None and cached[0] is tags and cached[1] is vocab:
        return cached[2]
    bases = await library_bases()
    out = await asyncio.to_thread(
        prompt_board.offers, vocab.general, tags, vocab.names, bases
    )
    tag_index.store_derived("board-offers", gen, (tags, vocab, out))
    return out
