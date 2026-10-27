"""The tag lists: grouped counts for the gallery autocomplete and the tag
browser (:func:`list_tags`), and the Tags page rows (:func:`browse`), one per
tag name with its count, category, last use and cover. Cached in
:mod:`services.tag_index`."""

from __future__ import annotations

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import (
    character_names,
    image_visibility,
    tag_categories,
    tag_covers,
    tag_index,
    tag_kinds,
)

SOURCES = ("all", "ai", "prompt", "manual")


def source_clause(source: str):
    """Restrict ``image_tags`` rows to one source (``all``: no restriction)."""
    tag = t.image_tags.c.tag
    manual = tag.like(f"{tag_kinds.MANUAL_PREFIX}%")
    prompt = tag.like(f"{tag_kinds.PROMPT_PREFIX}%")
    if source == "manual":
        return manual
    if source == "prompt":
        return prompt
    if source == "ai":
        return sa.and_(~manual, ~prompt)
    return sa.true()


async def list_tags(
    *, include_manual: bool, include_prompt: bool, merge_sources: bool
) -> list[dict]:
    """Grouped tag counts (``{_id, count}``) for the browser and the gallery
    autocomplete."""
    cache_key = f"m{int(include_manual)}:p{int(include_prompt)}:s{int(merge_sources)}"
    cached = tag_index.read_view(cache_key)
    if cached is not None:
        return cached

    gen = tag_index.current_generation()

    # Merge mode (gallery search): collapse the three sources of each tag into
    # one cross-source `any:<base>` entry counting *distinct images*, so a tag
    # the user both prompt- and manual-tagged isn't double-counted.
    if merge_sources:
        stmt = (
            sa.select(
                t.image_tags.c.base,
                sa.func.count(sa.distinct(t.image_tags.c.image_id)).label("count"),
            )
            .group_by(t.image_tags.c.base)
            .order_by(sa.text("count DESC"))
        )
        async with async_conn() as conn:
            rows = (await conn.execute(stmt)).fetchall()
        merged = [
            {"_id": f"{tag_kinds.ANY_PREFIX}{r.base}", "count": r.count}
            for r in rows
            if r.base
        ]
        tag_index.store_view(cache_key, gen, merged)
        return merged

    # AI tags are primary (no prefix). Manual tags are `manual:<tag>`, prompt-
    # extracted tags are `prompt:<term>`. By default the browser is AI-only; the
    # Tags view opts into the other kinds.
    stmt = sa.select(t.image_tags.c.tag, sa.func.count().label("count"))
    for prefix in tag_kinds.excluded_prefixes(
        include_manual=include_manual, include_prompt=include_prompt
    ):
        stmt = stmt.where(~t.image_tags.c.tag.like(f"{prefix}%"))
    stmt = stmt.group_by(t.image_tags.c.tag).order_by(sa.text("count DESC"))

    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    result = [{"_id": r.tag, "count": r.count} for r in rows]
    tag_index.store_view(cache_key, gen, result)
    return result


async def browse(source: str = "all") -> list[dict]:
    """One entry per tag name for the Tags page, the sources it was found by
    merged (``source`` keeps only one): distinct images, character or general,
    when it was last used (newest file time) and its cover (the image its
    mosaic leads with)."""
    cache_key = f"browse:{source}"
    cached = tag_index.read_view(cache_key)
    if cached is not None:
        return cached

    gen = tag_index.current_generation()
    result = await _browse(source)
    tag_index.store_view(cache_key, gen, result)
    return result


async def character_rows(vocab: tag_categories.Vocab) -> list[dict]:
    """:func:`browse` rows (every source) of the tags that may be characters
    (:func:`character_names.may_be_characters`): the same counts and covers,
    without aggregating the rest of the library unless the Tags page already
    has. Not cached: the caller caches what it builds from them."""
    cached = tag_index.read_view("browse:all")
    async with async_conn() as conn:
        maybe = await character_names.may_be_characters(conn, vocab)
        if cached is not None:
            return [r for r in cached if r["tag"].lower() in maybe]
        # A walk of the base index, no image lookups: a few hundredths of a
        # second against most of a second for every tag's aggregate.
        bases = (
            await conn.execute(
                sa.select(t.image_tags.c.base)
                .distinct()
                .where(t.image_tags.c.base != "")
            )
        ).scalars()
        wanted = [b for b in bases if b.lower() in maybe]
    if not wanted:
        return []
    return await _browse("all", wanted, vocab)


async def _browse(
    source: str,
    bases: list[str] | None = None,
    vocab: tag_categories.Vocab | None = None,
) -> list[dict]:
    """:func:`browse`'s rows, uncached; only ``bases`` when given."""
    it, im, tm = t.image_tags, t.images, t.tag_meta
    # One pass over the tag rows, feeding both aggregates. The visible images
    # are materialized first (a few thousand rows), so each of the ~50 tag
    # rows an image has joins against that small set instead of looking the
    # image up by its long `_id` again; filtering the tag rows before the
    # join keeps one source's pass from visiting the others' rows. Twice the
    # per-row lookups and a plan that scanned every source cost 2-15x more.
    vis = (
        sa.select(im.c._id, im.c.mtime, sa.literal_column("rowid").label("rid"))
        .where(image_visibility.not_quarantined())
        .cte("vis")
        .prefix_with("MATERIALIZED")
    )
    rows_cte = (
        sa.select(
            it.c.base,
            it.c.image_id,
            vis.c.mtime.label("mtime"),
            vis.c.rid,
            (vis.c._id == tm.c.thumb_image_id).label("pinned"),
        )
        .select_from(
            it.join(vis, vis.c._id == it.c.image_id).outerjoin(
                tm, tm.c.tag == it.c.base
            )
        )
        .where(
            source_clause(source),
            it.c.base != "",
            sa.true() if bases is None else it.c.base.in_(bases),
        )
        .cte("r")
        .prefix_with("MATERIALIZED")
    )
    rc = rows_cte.c
    agg = (
        sa.select(
            rc.base,
            sa.func.count(sa.distinct(rc.image_id)).label("count"),
            sa.func.max(rc.mtime).label("last_used"),
        )
        .group_by(rc.base)
        .cte("agg")
        .prefix_with("MATERIALIZED")
    )
    # Each tag's shuffle offset, worked out once per tag from the small
    # per-tag table rather than once per tagged image.
    seeds = (
        sa.select(agg.c.base, tag_covers.seed_sql(agg.c.base).label("seed"))
        .cte("seeds")
        .prefix_with("MATERIALIZED")
    )
    # The cover, by the mosaic's own rule (samples_for_tag): the pinned image
    # if it is visible and carries the tag, else the first of the shuffle.
    # The shuffle key is never negative, so a pin's -1 always wins.
    key = sa.case(
        (rc.pinned == sa.true(), -1),
        else_=tag_covers.shuffle_rank(rc.rid, seeds.c.seed),
    )
    # SQLite takes a bare column (image_id) from the row holding min() of the
    # group: the cover without a window sorting every row.
    cov = (
        sa.select(rc.base, rc.image_id.label("cover"), sa.func.min(key))
        .select_from(rows_cte.join(seeds, seeds.c.base == rc.base))
        .group_by(rc.base)
        .subquery()
    )
    stmt = (
        sa.select(agg.c.base, agg.c.count, agg.c.last_used, cov.c.cover)
        .select_from(agg.join(cov, cov.c.base == agg.c.base))
        .order_by(agg.c.count.desc(), agg.c.base)
    )
    if vocab is None:
        vocab = await tag_categories.load()  # a file read: before a connection
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
        characters = await character_names.character_names(
            conn, vocab, {r.base for r in rows}
        )

    return [
        {
            "tag": r.base,
            "count": r.count,
            "category": tag_categories.category(r.base, characters),
            "last_used": r.last_used,
            "thumb_image_id": r.cover,
        }
        for r in rows
    ]
