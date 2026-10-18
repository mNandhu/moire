"""Tag index: the single owner of the aggregated tag views and their cache.

The Tags browser reads two derived views over the ``image_tags`` join table:

- the **tag list**: grouped counts, either per stored tag or collapsed across
  sources into one ``any:<base>`` entry counting distinct images;
- the **mosaic samples**: up to N images per tag, a pinned ``tag_meta``
  thumbnail first, then random fill.

Both are expensive (a full ``GROUP BY``; an ``ORDER BY RANDOM()`` scan), so both
are memoized with a short TTL. **Invalidation belongs to this module, not to its
callers.** Tag-state writers dirty the index through :func:`invalidate` once
their transaction has committed; see :mod:`services.image_tags` (which owns
every async tag write) and :func:`services.reproject._flush_batch` (which owns
its own sync transaction and so invalidates per batch). Routers never reach for
the cache.

Staleness rule
--------------
A cached entry is valid only if it is within its TTL *and* was computed in the
current generation. :func:`invalidate` bumps the generation, which also means a
read that started before a write cannot store its now-stale result afterwards:
the reader captures the generation before touching the database and discards its
result on store if that generation has moved. Without that discard, a write
landing mid-query would leave stale data cached for a full TTL.

The generation lock is a plain ``threading.Lock`` rather than an ``asyncio``
one: reprojection invalidates from scanner threads, and every critical section
here is a dict operation with no await inside it.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import image_tags

_TAGS_TTL_SECONDS = 30.0
_SAMPLES_TTL_SECONDS = 60.0

_LOCK = threading.Lock()
_generation = 0
# Each entry is (stored_at, generation, value).
_tags_cache: dict[str, tuple[float, int, list[dict]]] = {}
_samples_cache: dict[tuple[str, int], tuple[float, int, list[dict]]] = {}


# --- Cache primitives ---------------------------------------------------------


def invalidate() -> None:
    """Mark every cached view stale. Safe to call from sync threads and from the
    event loop. Callers invalidate *after* their transaction commits, so a
    concurrent reader can never repopulate from uncommitted state."""
    global _generation
    with _LOCK:
        _generation += 1
        _tags_cache.clear()
        _samples_cache.clear()


def current_generation() -> int:
    with _LOCK:
        return _generation


def _read(
    cache: dict[Any, tuple[float, int, list[dict]]], key: Any, ttl: float
) -> list[dict] | None:
    now = time.time()
    with _LOCK:
        entry = cache.get(key)
        if entry is None:
            return None
        stored_at, gen, value = entry
        if gen != _generation or (now - stored_at) >= ttl:
            return None
        return value


def _store(
    cache: dict[Any, tuple[float, int, list[dict]]],
    key: Any,
    gen: int,
    value: list[dict],
) -> None:
    """Store only if no write intervened since ``gen`` was captured."""
    with _LOCK:
        if gen != _generation:
            return
        cache[key] = (time.time(), gen, value)


def reset_for_tests() -> None:
    """Drop all cached state and the generation counter."""
    global _generation
    with _LOCK:
        _generation = 0
        _tags_cache.clear()
        _samples_cache.clear()


# --- Aggregated views ---------------------------------------------------------


async def list_tags(
    *, include_manual: bool, include_prompt: bool, merge_sources: bool
) -> list[dict]:
    """Grouped tag counts for the browser and the gallery autocomplete."""
    cache_key = f"m{int(include_manual)}:p{int(include_prompt)}:s{int(merge_sources)}"
    cached = _read(_tags_cache, cache_key, _TAGS_TTL_SECONDS)
    if cached is not None:
        return cached

    gen = current_generation()

    # Merge mode (gallery search): collapse the three sources of each tag into
    # one cross-source `any:<base>` entry counting *distinct images*, so a tag
    # the user both prompt- and manual-tagged isn't double-counted. No thumbs:
    # the autocomplete only needs id + count.
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
            {"_id": f"{image_tags.ANY_PREFIX}{r.base}", "count": r.count}
            for r in rows
            if r.base
        ]
        _store(_tags_cache, cache_key, gen, merged)
        return merged

    # AI tags are primary (no prefix). Manual tags are `manual:<tag>`, prompt-
    # extracted tags are `prompt:<term>`. By default the browser is AI-only; the
    # Tags view opts into the other kinds.
    stmt = sa.select(
        t.image_tags.c.tag,
        sa.func.count().label("count"),
        # MAX picks the newest image id (ids sort like _id desc) for the default
        # mosaic thumbnail.
        sa.func.max(t.image_tags.c.image_id).label("sample_image_id"),
    )
    for prefix in image_tags.excluded_prefixes(
        include_manual=include_manual, include_prompt=include_prompt
    ):
        stmt = stmt.where(~t.image_tags.c.tag.like(f"{prefix}%"))
    stmt = stmt.group_by(t.image_tags.c.tag).order_by(sa.text("count DESC"))

    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
        tag_ids = [r.tag for r in rows]
        overrides: dict[str, str] = {}
        if tag_ids:
            ov_rows = (
                await conn.execute(
                    sa.select(t.tag_meta.c.tag, t.tag_meta.c.thumb_image_id).where(
                        t.tag_meta.c.tag.in_(tag_ids)
                    )
                )
            ).fetchall()
            overrides = {r.tag: r.thumb_image_id for r in ov_rows if r.thumb_image_id}

    result = [
        {
            "_id": r.tag,
            "count": r.count,
            "thumb_image_id": overrides.get(r.tag) or r.sample_image_id,
        }
        for r in rows
    ]
    _store(_tags_cache, cache_key, gen, result)
    return result


async def samples_for_tag(tag: str, per: int) -> list[dict]:
    """Up to ``per`` distinct images for one tag's mosaic card. A pinned
    ``tag_meta`` thumbnail leads when present; the rest are random fill. Rows
    carry ``_id``/``width``/``height``/``blurhash``; the route decorates them
    with the thumb URL."""
    cache_key = (tag, per)
    cached = _read(_samples_cache, cache_key, _SAMPLES_TTL_SECONDS)
    if cached is not None:
        return cached

    gen = current_generation()

    cols = (
        t.images.c._id,
        t.images.c.thumb_key,
        t.images.c.width,
        t.images.c.height,
        t.images.c.blurhash,
    )
    out: list[dict] = []
    seen: set[str] = set()

    async with async_conn() as conn:
        # A pinned thumbnail (tag_meta) leads the mosaic when present.
        pinned = (
            await conn.execute(
                sa.select(t.tag_meta.c.thumb_image_id).where(t.tag_meta.c.tag == tag)
            )
        ).scalar()
        if pinned:
            row = (
                await conn.execute(
                    sa.select(*cols).where(
                        t.images.c._id == pinned,
                        sa.exists(
                            sa.select(1).where(
                                t.image_tags.c.image_id == t.images.c._id,
                                t.image_tags.c.tag == tag,
                            )
                        ),
                    )
                )
            ).first()
            if row is not None:
                seen.add(row._id)
                out.append(dict(row._mapping))

        # ORDER BY RANDOM() gives varied, non-duplicated images across tags, fixes
        # common tags all showing the same most-recent image. Full scan + sort of
        # the matching rows, but the result is cached (TTL) and per-tag match sets
        # are small. Over-fetch to backfill any collision with the pinned image.
        remaining = per - len(out)
        if remaining > 0:
            rows = (
                await conn.execute(
                    sa.select(*cols)
                    .select_from(
                        t.images.join(
                            t.image_tags, t.image_tags.c.image_id == t.images.c._id
                        )
                    )
                    .where(t.image_tags.c.tag == tag)
                    .order_by(sa.func.random())
                    .limit(remaining + (1 if pinned else 0))
                )
            ).fetchall()
            for row in rows:
                if row._id in seen:
                    continue
                seen.add(row._id)
                out.append(dict(row._mapping))
                if len(out) >= per:
                    break

    samples = [
        {
            "_id": d["_id"],
            "width": d.get("width"),
            "height": d.get("height"),
            "blurhash": d.get("blurhash"),
        }
        for d in out
    ]
    _store(_samples_cache, cache_key, gen, samples)
    return samples
