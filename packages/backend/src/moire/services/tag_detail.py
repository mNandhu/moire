"""The Tags page panel for one tag (:func:`detail`), and :func:`image_ids`,
the visible images carrying a tag that characters, recipes and outfits read
from too (with :func:`visible_count`, how many images there are to read).
One small query per panel section."""

from __future__ import annotations

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import character_names, image_visibility, tag_categories, tag_covers, tag_kinds
from .tag_browse import source_clause

_RELATED = 40


def image_ids(bases: list[str], source: str = "all"):
    """The visible images carrying any of ``bases``, as a subquery."""
    it = t.image_tags
    return (
        sa.select(it.c.image_id)
        .where(
            it.c.base.in_(bases),
            source_clause(source),
            image_visibility.visible_tag_rows(it),
        )
        .distinct()
        .scalar_subquery()
    )


async def visible_count(conn) -> int:
    """How many images are visible: what a tag's share of the library (a
    character's signature, a LoRA's spread) is measured against."""
    return (
        await conn.execute(
            sa.select(sa.func.count()).where(image_visibility.not_quarantined())
        )
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
            .where(it.c.base.in_(bases), image_visibility.visible_tag_rows(it))
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


async def _related(conn, ids, bases: list[str]) -> list[dict]:
    """The other tags on these images, most shared first, untrimmed."""
    it = t.image_tags
    rows = (
        await conn.execute(
            sa.select(
                it.c.base, sa.func.count(sa.distinct(it.c.image_id)).label("count")
            )
            .where(it.c.image_id.in_(ids), it.c.base.not_in(bases), it.c.base != "")
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
    boilerplate and still have some left."""
    bases = [base, *aliases]
    ids = image_ids(bases, source)
    in_ids = t.images.c._id.in_(ids)
    vocab = await tag_categories.load()  # a file read: before taking a connection
    async with async_conn() as conn:
        span = await _span(conn, in_ids)
        if not span[0]:
            return None
        sources = await _sources(conn, bases)
        months = await _months(conn, in_ids)
        loras = await _loras(conn, ids)
        embeddings = await _embeddings(conn, ids)
        workflows = await _workflows(conn, in_ids)
        weights = await _weights(conn, ids, bases)
        related = await _related(conn, ids, bases)
        pin = (await tag_covers.pins(conn, {base})).get(base)
        characters = await character_names.character_names(conn, vocab, {base})

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
