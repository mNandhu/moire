"""Derived views over every tag in the library: the attire and facet maps,
the library's tag groups, its tag names and the prompt board's offers.

Each is costly to build and changes only with a tag write (or a new
vocabulary / Danbooru list), so each is kept in :mod:`services.tags.index`'s
derived cache: the generation is captured before reading, and a write landing
mid-build discards the result.

The ``shown_*`` views are what the routes serve: the same, without the tag
names the Global Sensitivity Filter hides. Filtering happens here, once,
rather than in each route; each filtered result is kept while its source is
the same object and the filter's maximum hasn't changed.
"""

from __future__ import annotations

import asyncio

import sqlalchemy as sa

from ...database.db import async_conn
from ...database import schema as t
from typing import Any, Callable

from ..characters import attire
from . import (
    danbooru as danbooru_tags,
    sensitivity_filter,
    categories as tag_categories,
    descriptions as tag_descriptions,
    index as tag_index,
    rename as tag_rename,
)
from ..generate import prompt_board


async def library_bases() -> list[str]:
    """Every tag name the library's images carry, prefix dropped. Kept until
    the next tag write."""
    return await tag_index.cached("derived", "library-bases", _library_bases)


async def _library_bases() -> list[str]:
    async with async_conn() as conn:
        return [
            b
            for b in (
                await conn.execute(sa.select(t.image_tags.c.base).distinct())
            ).scalars()
            if b
        ]


async def tag_maps() -> tuple[dict[str, str], dict[str, str], dict]:
    """The attire and facet maps (and the library's tag groups) over the tagger's vocabulary plus every tag in
    the library (free-form prompt tags like ``pastel_pink_dolphin_shorts``
    included). Classifying ~10k names takes tens of milliseconds, so they are
    built together in a thread and kept until a tag write or a new
    vocabulary."""
    vocab = await tag_categories.load()

    async def build():
        library = await library_bases()
        names = list(dict.fromkeys([*vocab.general, *library]))
        return (
            vocab.general,
            *await asyncio.to_thread(
                lambda: (
                    attire.attire_tags(names),
                    attire.facets(names),
                    attire.library_groups(library),
                )
            ),
        )

    _, attire_map, facet_map, groups = await tag_index.cached(
        "derived", "tag-maps", build, valid=lambda v: v[0] is vocab.general
    )
    return attire_map, facet_map, groups


async def library_aliases() -> dict[str, list[str]]:
    """``tag -> [alias, ...]``: Danbooru's aliases of the library's tags, so
    typing an alias (``anime_screencap``) can suggest the tag
    (``anime_screenshot``). An alias the library also carries as a tag of
    its own is left out: it suggests itself. Never starts the list's
    download. Kept until a tag write or a new list."""
    tags = await danbooru_tags.load_present()

    async def build():
        library = frozenset(await library_bases())
        out: dict[str, list[str]] = {}
        for alias, tag in tags.aliases.items():
            if tag in library and alias not in library and alias != tag:
                out.setdefault(tag, []).append(alias)
        return tags, out

    return (
        await tag_index.cached(
            "derived", "library-aliases", build, valid=lambda v: v[0] is tags
        )
    )[1]


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
    tags = await danbooru_tags.load()
    vocab = await tag_categories.load()

    async def build():
        bases = await library_bases()
        out = await asyncio.to_thread(
            prompt_board.offers, vocab.general, tags, vocab.names, bases
        )
        return tags, vocab, out

    return (
        await tag_index.cached(
            "derived",
            "board-offers",
            build,
            valid=lambda v: v[0] is tags and v[1] is vocab,
        )
    )[2]


# --- What the routes serve: the views above, without hidden tag names --------

_filtered: dict[str, tuple[Any, int | None, Any]] = {}


def _shown(key: str, source: Any, keep: Callable[[Any], Any]) -> Any:
    """``keep(source)`` while the filter is on (``source`` itself while it is
    off), kept while ``source`` is the same object and the maximum holds."""
    top = sensitivity_filter.max_level()
    if top is None:
        return source
    hit = _filtered.get(key)
    if hit is not None and hit[0] is source and hit[1] == top:
        return hit[2]
    result = keep(source)
    _filtered[key] = (source, top, result)
    return result


def _names_in(rows: list[list]) -> list[list]:
    return [r for r in rows if sensitivity_filter.allowed(r[0])]


async def shown_attire() -> dict[str, str]:
    return _shown("attire", (await tag_maps())[0], sensitivity_filter.allowed_keys)


async def shown_facets() -> dict[str, str]:
    return _shown("facets", (await tag_maps())[1], sensitivity_filter.allowed_keys)


async def shown_groups() -> dict:
    return _shown(
        "groups",
        (await tag_maps())[2],
        lambda g: {**g, "tags": sensitivity_filter.allowed_keys(g.get("tags", {}))},
    )


async def shown_board_offers() -> dict[str, list[list]]:
    return _shown(
        "offers",
        await board_offers(),
        lambda offers: {k: _names_in(v) for k, v in offers.items()},
    )


async def shown_aliases() -> dict[str, list[str]]:
    return _shown(
        "aliases",
        await library_aliases(),
        lambda aliases: {
            tag: [a for a in names if sensitivity_filter.allowed(a)]
            for tag, names in sensitivity_filter.allowed_keys(aliases).items()
        },
    )


async def shown_descriptions() -> dict[str, str]:
    """``tag -> description`` for the vocabulary and the library's tags (and
    the Danbooru aliases of either, when that list is in)."""
    tags = await danbooru_tags.load_present()
    vocab = await tag_categories.load()
    served = tag_descriptions.served(tags.aliases, vocab.general, await library_bases())
    return _shown("descriptions", served, sensitivity_filter.allowed_keys)


async def shown_merge_suggestions() -> dict:
    return _shown(
        "merges",
        await tag_rename.merge_suggestions(),
        lambda got: {
            **got,
            "suggestions": [
                x
                for x in got["suggestions"]
                if all(sensitivity_filter.allowed(n) for n in (x["from"], *x["to"]))
            ],
        },
    )


def shown_names(names: list[str]) -> list[str]:
    """``names`` without those the filter hides."""
    return [n for n in names if sensitivity_filter.allowed(n)]


def reset_for_tests() -> None:
    _filtered.clear()
