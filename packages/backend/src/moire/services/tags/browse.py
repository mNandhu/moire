"""The tag lists: grouped counts for the gallery autocomplete and the tag
browser (:func:`list_tags`), and the Tags page rows (:func:`browse`), one per
tag name with its count, category, last use and cover. Cached in
:mod:`services.tags.index`."""

from __future__ import annotations

import sqlalchemy as sa

from ...database.db import async_conn
from ...database import schema as t
from . import (
    character_names,
    sensitivity_filter,
    categories as tag_categories,
    covers as tag_covers,
    index as tag_index,
    kinds as tag_kinds,
)
from ..images import visibility as image_visibility

SOURCES = ("all", "ai", "prompt", "manual")

# Packs a cover's shuffle key and rowid into one integer (see `_browse`).
_PACK = 1 << 30


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
    autocomplete. While the sensitivity filter is on, only the images it
    shows count, and tags it hides are left out (so a tag whose images are
    all hidden goes too)."""
    cache_key = f"m{int(include_manual)}:p{int(include_prompt)}:s{int(merge_sources)}"
    return await tag_index.cached(
        "views",
        cache_key,
        lambda: _list_tags(
            include_manual=include_manual,
            include_prompt=include_prompt,
            merge_sources=merge_sources,
        ),
    )


async def _list_tags(
    *, include_manual: bool, include_prompt: bool, merge_sources: bool
) -> list[dict]:
    filtering = sensitivity_filter.max_level() is not None

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
        if filtering:
            stmt = stmt.where(image_visibility.visible_tag_rows())
        async with async_conn() as conn:
            rows = (await conn.execute(stmt)).fetchall()
        merged = [
            {"_id": f"{tag_kinds.ANY_PREFIX}{r.base}", "count": r.count}
            for r in rows
            if r.base and sensitivity_filter.allowed(r.base)
        ]
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
    if filtering:
        stmt = stmt.where(image_visibility.visible_tag_rows())

    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    result = [
        {"_id": r.tag, "count": r.count}
        for r in rows
        if sensitivity_filter.allowed(r.tag)
    ]
    return result


async def browse(source: str = "all") -> list[dict]:
    """One entry per tag name for the Tags page, the sources it was found by
    merged (``source`` keeps only one): distinct images, character or general,
    when it was last used (newest file time) and its cover (the image its
    mosaic leads with)."""

    async def build() -> list[dict]:
        # Only the images the filter shows count (``_browse``), and the tags it
        # hides are left out.
        return [
            r for r in await _browse(source) if sensitivity_filter.allowed(r["tag"])
        ]

    return await tag_index.cached("views", f"browse:{source}", build)


async def character_rows(vocab: tag_categories.Vocab) -> list[dict]:
    """:func:`browse` rows (every source) of the tags that may be characters
    (:func:`character_names.may_be_characters`): the same counts and covers,
    without aggregating the rest of the library unless the Tags page already
    has (served stale behind an AI job like the page). Not cached: the caller
    caches what it builds from them."""
    cached = tag_index.peek("views", "browse:all")
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
    if vocab is None:
        vocab = await tag_categories.load()  # a file read: before a connection
    async with async_conn() as conn:
        # The packed cover key needs every rowid below _PACK (see _stmt).
        top = await conn.scalar(
            sa.select(sa.func.max(sa.literal_column("rowid"))).select_from(t.images)
        )
        one_pass = source == "all" and (top or 0) < _PACK
        rows = (await conn.execute(_stmt(source, bases, one_pass))).fetchall()
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


def _stmt(source: str, bases: list[str] | None, one_pass: bool):
    """The browse aggregate: ``one_pass`` (every source, all rowids below
    ``_PACK``) or the per-source shape."""
    it, im, tm = t.image_tags, t.images, t.tag_meta
    tag_rows = sa.and_(
        source_clause(source),
        it.c.base != "",
        sa.true() if bases is None else it.c.base.in_(bases),
    )
    # The visible images are materialized first (a few thousand rows), so
    # each of the ~50 tag rows an image has joins against that small set
    # instead of looking the image up by its long `_id` again; the per-tag
    # seeds likewise, for just the tags found (source and bases applied).
    vis = (
        sa.select(im.c._id, im.c.mtime, sa.literal_column("rowid").label("rid"))
        .where(image_visibility.visible())
        .cte("vis")
        .prefix_with("MATERIALIZED")
    )
    # The cover, by the mosaic's own rule (samples_for_tag): the pinned image
    # if it is visible and carries the tag, else the first of the shuffle.
    # One min() over a packed integer `key * _PACK + rowid` picks it without
    # leaning on SQLite's bare-column-with-min() behaviour. The shuffle rank
    # is in [0, _HASH_MOD) < 2^32, a pin's key is -1 (below every rank).
    # Bounds: rowid < _PACK = 2^30, so rank * 2^30 + rowid < 2^32 * 2^30 =
    # 2^62 < 2^63, and a pin packs to -2^30 + rowid, in [-2^30, 0). SQLite
    # turns integer overflow into REAL, so the bound must hold: a rowid of
    # 2^30 (a billion inserts) would decode to the wrong image, so the caller
    # takes the other shape past it. Decode: packed >= 0 -> packed % 2^30;
    # packed < 0 -> packed + 2^30.
    if one_pass:
        # Every source: one pass in base-index order, no intermediate rows.
        wanted = sa.select(it.c.base).where(tag_rows).distinct().subquery()
        seeds = (
            sa.select(
                wanted.c.base,
                tag_covers.seed_sql(wanted.c.base).label("seed"),
                tm.c.thumb_image_id.label("pin"),
            )
            .select_from(wanted.outerjoin(tm, tm.c.tag == wanted.c.base))
            .cte("seeds")
            .prefix_with("MATERIALIZED")
        )
        key = sa.case(
            (vis.c._id == seeds.c.pin, -1),
            else_=tag_covers.shuffle_rank(vis.c.rid, seeds.c.seed),
        )
        agg = (
            sa.select(
                it.c.base,
                sa.func.count(sa.distinct(it.c.image_id)).label("count"),
                sa.func.max(vis.c.mtime).label("last_used"),
                sa.func.min(key * _PACK + vis.c.rid).label("packed"),
            )
            .select_from(
                it.join(vis, vis.c._id == it.c.image_id).join(
                    seeds, seeds.c.base == it.c.base
                )
            )
            .where(tag_rows)
            .group_by(it.c.base)
            .subquery()
        )
        cover_rid = sa.case(
            (agg.c.packed < 0, agg.c.packed + _PACK), else_=agg.c.packed % _PACK
        )
        stmt = (
            sa.select(agg.c.base, agg.c.count, agg.c.last_used, im.c._id.label("cover"))
            .select_from(agg.join(im, sa.literal_column("images.rowid") == cover_rid))
            .order_by(agg.c.count.desc(), agg.c.base)
        )
    else:
        # One source: the old shape, which SQLite plans through the tag index
        # (the prefix match) instead of a base-ordered scan that tests every
        # row of every source: 5-10x slower for a small source, and the
        # packed one-pass did not beat it on the wide ones.
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
            .where(tag_rows)
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
        seeds = (
            sa.select(agg.c.base, tag_covers.seed_sql(agg.c.base).label("seed"))
            .cte("seeds")
            .prefix_with("MATERIALIZED")
        )
        key = sa.case(
            (rc.pinned == sa.true(), -1),
            else_=tag_covers.shuffle_rank(rc.rid, seeds.c.seed),
        )
        # SQLite takes a bare column (image_id) from the row holding min() of
        # the group: the cover without a window sorting every row.
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
    return stmt
