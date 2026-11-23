"""The Tags page panel for one tag (:func:`detail`), and :func:`image_ids`,
the visible images carrying a tag that characters, recipes and outfits read
from too (with :func:`visible_count`, how many images there are to read).
One small query per panel section."""

from __future__ import annotations

import json

import sqlalchemy as sa
from sqlalchemy.sql import operators
from sqlalchemy.sql.elements import UnaryExpression

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
from .browse import source_clause

_RELATED = 40

# The panel's image set, worked out once per request into a temp table of the
# connection that reads it: every section filters by it, and recomputing it
# for each (a dense tag has tens of thousands of rows) cost most of the time.
_IDS = sa.Table(
    "detail_ids",
    sa.MetaData(),
    sa.Column("image_id", sa.Text, primary_key=True),
    prefixes=["TEMPORARY"],
)


def unindexed(column):
    """``column`` with a unary ``+``: the same value and collation, but
    SQLite won't look it up in an index, so a filter on it is checked
    against rows another index finds (for ``image_id IN (...)``: walk the
    base index and test each row, instead of probing every image)."""
    return UnaryExpression(column, operator=operators.custom_op("+"), type_=column.type)


def image_ids(bases: list[str], source: str = "all"):
    """The visible images carrying any of ``bases``, as a select."""
    it = t.image_tags
    return (
        sa.select(it.c.image_id)
        .where(
            it.c.base.in_(bases),
            source_clause(source),
            image_visibility.visible_image(it.c.image_id),
        )
        .distinct()
    )


async def visible_count(conn) -> int:
    """How many images are visible: what a tag's share of the library (a
    character's signature, a LoRA's spread) is measured against."""
    return (
        await conn.execute(sa.select(sa.func.count()).where(image_visibility.visible()))
    ).scalar_one()


async def _span(conn, in_ids):
    """(count, first use, last use)."""
    return (
        await conn.execute(
            sa.select(
                sa.func.count(),
                sa.func.min(t.images.c.mtime),
                sa.func.max(t.images.c.mtime),
            ).where(in_ids)
        )
    ).one()


async def _sources(conn, bases: list[str]) -> dict[str, int]:
    """Visible tag rows per source."""
    it = t.image_tags
    kinds = (
        await conn.execute(
            sa.select(it.c.tag, sa.func.count())
            .where(it.c.base.in_(bases), image_visibility.visible_image(it.c.image_id))
            .group_by(it.c.tag)
        )
    ).fetchall()
    sources = {"ai": 0, "prompt": 0, "manual": 0}
    for tag, n in kinds:
        kind = (
            "manual"
            if tag_kinds.is_manual(tag)
            else "prompt"
            if tag_kinds.is_prompt(tag)
            else "ai"
        )
        sources[kind] += n
    return sources


async def _months(conn, in_ids) -> list[dict]:
    month = sa.func.strftime("%Y-%m", t.images.c.mtime, "unixepoch", "localtime")
    rows = (
        await conn.execute(
            sa.select(month.label("month"), sa.func.count().label("count"))
            .where(in_ids, t.images.c.mtime.isnot(None))
            .group_by(month)
            .order_by(month)
        )
    ).fetchall()
    return [{"month": m, "count": n} for m, n in rows]


async def _loras(conn, ids) -> list[dict]:
    """The five loras most used, with their usual weight."""
    rows = (
        await conn.execute(
            sa.select(
                t.image_loras.c.name,
                sa.func.count().label("count"),
                sa.func.avg(t.image_loras.c.strength).label("strength"),
            )
            .where(t.image_loras.c.image_id.in_(ids))
            .group_by(t.image_loras.c.name)
            .order_by(sa.text("count DESC"), t.image_loras.c.name)
            .limit(5)
        )
    ).fetchall()
    return [
        {
            "name": r.name,
            "count": r.count,
            "strength": None if r.strength is None else round(r.strength, 2),
        }
        for r in rows
    ]


async def _embeddings(conn, ids) -> list[dict]:
    """The five positive-prompt embeddings most used."""
    emb = t.image_embeddings
    emb_count = sa.func.count(sa.distinct(emb.c.image_id))
    rows = (
        await conn.execute(
            sa.select(emb.c.name, emb_count.label("count"))
            .where(emb.c.image_id.in_(ids), emb.c.negative.is_(False))
            .group_by(emb.c.name)
            .order_by(emb_count.desc(), emb.c.name)
            .limit(5)
        )
    ).fetchall()
    return [{"name": r.name, "count": r.count} for r in rows]


async def _workflows(conn, in_ids) -> list[dict]:
    rows = (
        await conn.execute(
            sa.select(
                t.images.c.gen_workflow_sig.label("sig"),
                sa.func.count().label("count"),
            )
            .where(in_ids, t.images.c.gen_workflow_sig.isnot(None))
            .group_by(t.images.c.gen_workflow_sig)
            .order_by(sa.text("count DESC"))
        )
    ).fetchall()
    return [{"sig": r.sig, "count": r.count} for r in rows]


async def _weights(conn, ids, bases: list[str]) -> dict | None:
    """The prompt weights the tag was written at on these images: lowest,
    highest, the most common (the lowest on a tie) and how many of the
    prompted images weighted it, counted per image (one written under two
    of ``bases`` counts once). ``None`` when no prompt weighted it."""
    gt = t.image_gen_terms
    w = sa.func.round(gt.c.weight, 2).label("w")
    where = (gt.c.image_id.in_(ids), gt.c.term.in_(bases))
    images = sa.func.count(sa.distinct(gt.c.image_id))
    rows = (
        await conn.execute(
            sa.select(w, images.label("count")).where(*where).group_by(w).order_by(w)
        )
    ).fetchall()
    weighted = (
        await conn.execute(sa.select(images).where(*where, w != 1))
    ).scalar_one()
    if not weighted:
        return None
    return {
        "min": rows[0].w,
        "max": rows[-1].w,
        "mode": max(rows, key=lambda r: r.count).w,
        "weighted": weighted,
        "prompted": (await conn.execute(sa.select(images).where(*where))).scalar_one(),
    }


# A tag on more than this share of the visible images counts its related
# tags by walking the whole base index (see _related).
_WIDE_SHARE = 0.25


async def _related(conn, ids, bases: list[str], wide: bool) -> list[dict]:
    """The other tags on these images, most shared first, untrimmed.

    Per image, the tag rows of each (about 90 us an image at 30k images);
    for a ``wide`` tag, every row in base order, checked against ``ids``
    (:func:`unindexed`), which costs the
    same whatever the tag and counts distinct images without sorting:
    1.67 -> 0.87 s for a tag on 18.6k of 30k images, but slower below about
    a quarter of them."""
    it = t.image_tags
    on = unindexed(it.c.image_id) if wide else it.c.image_id
    rows = (
        await conn.execute(
            sa.select(
                it.c.base, sa.func.count(sa.distinct(it.c.image_id)).label("count")
            )
            .where(on.in_(ids), it.c.base.not_in(bases), it.c.base != "")
            .group_by(it.c.base)
            .order_by(sa.text("count DESC"), it.c.base)
            .limit(_RELATED)
        )
    ).fetchall()
    return [{"tag": r.base, "count": r.count} for r in rows]


async def detail(
    base: str, source: str = "all", aliases: tuple[str, ...] = ()
) -> dict | None:
    """What the Tags page panel shows for one tag (``None`` when no image has
    it): counts by source, first and last use, images per month, and what the
    images were made with (loras with their usual weight, positive-prompt
    embeddings, workflow signatures, the prompt weights the tag was written
    at) or tagged with besides. ``aliases`` are
    other names of the same thing (a character's bare name), counted as one.
    Related tags come untrimmed (``_RELATED``) so the caller can drop its
    boilerplate and still have some left.

    Cached in :mod:`services.tags.index`, keyed by everything the answer
    depends on: the names, the source and the sensitivity filter's maximum."""
    key = json.dumps(
        ["detail", base, list(aliases), source, sensitivity_filter.max_level()]
    )
    return await tag_index.cached("views", key, lambda: _detail(base, source, aliases))


async def _detail(base: str, source: str, aliases: tuple[str, ...]) -> dict | None:
    bases = [base, *aliases]
    vocab = await tag_categories.load()  # a file read: before taking a connection
    async with async_conn() as conn:
        # The temp table lives on this pooled connection: always dropped, so
        # the next request to reuse the connection starts clean.
        await conn.exec_driver_sql("DROP TABLE IF EXISTS temp.detail_ids")
        await conn.execute(sa.schema.CreateTable(_IDS))
        try:
            await conn.execute(
                sa.insert(_IDS).from_select(["image_id"], image_ids(bases, source))
            )
            ids = sa.select(_IDS.c.image_id)
            in_ids = t.images.c._id.in_(ids)
            span = await _span(conn, in_ids)
            if not span[0]:
                return None
            sources = await _sources(conn, bases)
            months = await _months(conn, in_ids)
            loras = await _loras(conn, ids)
            embeddings = await _embeddings(conn, ids)
            workflows = await _workflows(conn, in_ids)
            weights = await _weights(conn, ids, bases)
            wide = span[0] > _WIDE_SHARE * await visible_count(conn)
            related = await _related(conn, ids, bases, wide)
            pin = (await tag_covers.pins(conn, {base})).get(base)
            characters = await character_names.character_names(conn, vocab, {base})
        finally:
            await conn.exec_driver_sql("DROP TABLE IF EXISTS temp.detail_ids")

    return {
        "tag": base,
        "count": span[0],
        "category": tag_categories.category(base, characters),
        "first_used": span[1],
        "last_used": span[2],
        "sources": sources,
        "months": months,
        "loras": loras,
        "embeddings": embeddings,
        "workflows": workflows,
        "weights": weights,
        "related": related,
        "thumb_image_id": pin,
    }
