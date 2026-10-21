"""Tag index: the single owner of the aggregated tag views and their cache.

The Tags browser reads two derived views over the ``image_tags`` join table:

- the **tag list**: grouped counts, either per stored tag or collapsed across
  sources into one ``any:<base>`` entry counting distinct images;
- the **mosaic samples**: up to N images per tag, a pinned ``tag_meta``
  thumbnail first, then a fixed per-tag shuffle of the rest.

Both are expensive (a full ``GROUP BY``; a sorted scan per tag), so both
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
from . import image_tags, tag_categories

_TAGS_TTL_SECONDS = 30.0
_SAMPLES_TTL_SECONDS = 60.0

_LOCK = threading.Lock()
_generation = 0
# Each entry is (stored_at, generation, value).
_tags_cache: dict[str, tuple[float, int, list[dict]]] = {}
_samples_cache: dict[tuple[str, int], tuple[float, int, list[dict]]] = {}
# Values derived from every tag (the attire and facet maps): no TTL, only the
# generation, since they are costly to build and change only with a write.
_derived_cache: dict[str, tuple[int, Any]] = {}


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
        _derived_cache.clear()


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


def read_view(key: str) -> list[dict] | None:
    """A view another module caches alongside the tag lists (same TTL, same
    invalidation), or None when stale."""
    return _read(_tags_cache, key, _TAGS_TTL_SECONDS)


def store_view(key: str, gen: int, value: list[dict]) -> None:
    """Cache ``value`` under ``key`` unless a write intervened since ``gen``
    (:func:`current_generation`, read before building it)."""
    _store(_tags_cache, key, gen, value)


def read_derived(key: str) -> Any:
    """A value stored with :func:`store_derived`, ``None`` once a write
    intervened."""
    with _LOCK:
        entry = _derived_cache.get(key)
        return entry[1] if entry is not None and entry[0] == _generation else None


def store_derived(key: str, gen: int, value: Any) -> None:
    """Keep ``value`` until the next write, unless one already happened since
    ``gen`` was captured."""
    with _LOCK:
        if gen == _generation:
            _derived_cache[key] = (gen, value)


def reset_for_tests() -> None:
    """Drop all cached state and the generation counter."""
    global _generation
    with _LOCK:
        _generation = 0
        _tags_cache.clear()
        _samples_cache.clear()
        _derived_cache.clear()


# --- Pinned thumbnails ---------------------------------------------------------


_HASH_MUL, _HASH_MOD = 2654435761, 4294967291
# The seed reads this many leading characters of the name (plus its length).
_SEED_CHARS, _SEED_MOD = 32, 1000003


def _seed(base: str) -> int:
    """A tag's shuffle offset, spread over the whole hash range. Mirrored in
    SQL by :func:`_seed_sql`, so the list can pick the same cover the mosaic
    leads with. A small offset (a function of the length and first letter
    only) barely rotated the shuffle, so every tag sharing images led with
    the same one."""
    h = len(base)
    for i in range(_SEED_CHARS):
        h = (h * 31 + (ord(base[i]) if i < len(base) else 0)) % _SEED_MOD
    return h * _HASH_MUL % _HASH_MOD


def _seed_sql(base_col):
    """:func:`_seed` in SQL. Run it once per tag, not per tagged image."""
    h = sa.func.length(base_col)
    for i in range(_SEED_CHARS):
        ch = sa.func.coalesce(sa.func.unicode(sa.func.substr(base_col, i + 1, 1)), 0)
        h = (h * 31 + ch) % _SEED_MOD
    return h * _HASH_MUL % _HASH_MOD


def _shuffle_key(seed):
    rowid = sa.literal_column(f"{t.images.name}.rowid")
    return (rowid * _HASH_MUL + seed) % _HASH_MOD


# How many matching rows a mosaic reads per image it shows, to find images
# from different batches.
SAMPLE_SPREAD = 8


def _shuffled(tag: str):
    """A fixed shuffle of a tag's images: mosaics look varied across tags (not
    every common tag showing the newest image) yet stay put when an unrelated
    write refreshes them. Multiplicative hashing of the rowid, seeded by the
    tag's name, whichever source is asked for; the first image is the tag's
    cover when nothing is pinned (:func:`browse` picks the same one)."""
    return _shuffle_key(_seed(pin_key(tag)))


def pin_key(tag: str) -> str:
    """The ``tag_meta`` key of any spelling of a tag: its base name. A pin
    belongs to the tag, whichever sources found it."""
    tag = image_tags.canonical_tag(tag)
    if image_tags.is_any(tag):
        return tag[len(image_tags.ANY_PREFIX) :]
    return image_tags.base_of(tag)


async def _pins(conn, bases: set[str]) -> dict[str, str]:
    if not bases:
        return {}
    rows = (
        await conn.execute(
            sa.select(t.tag_meta.c.tag, t.tag_meta.c.thumb_image_id).where(
                t.tag_meta.c.tag.in_(bases)
            )
        )
    ).fetchall()
    return {r.tag: r.thumb_image_id for r in rows if r.thumb_image_id}


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
            overrides = await _pins(conn, {image_tags.base_of(tag) for tag in tag_ids})

    result = [
        {
            "_id": r.tag,
            "count": r.count,
            "thumb_image_id": overrides.get(image_tags.base_of(r.tag))
            or r.sample_image_id,
        }
        for r in rows
    ]
    _store(_tags_cache, cache_key, gen, result)
    return result


async def samples_for_tag(tag: str, per: int) -> list[dict]:
    """Up to ``per`` distinct images for one tag's mosaic card (``tag`` a stored
    id, or ``any:<base>`` for every source). A pinned
    ``tag_meta`` thumbnail leads when present; the rest follow ``_shuffled``,
    one per generation batch while there are enough batches (a batch's images
    look alike), then the batches again. Rows
    carry ``_id``/``width``/``height``/``blurhash``; the route decorates them
    with the thumb URL."""
    cache_key = (tag, per)
    cached = _read(_samples_cache, cache_key, _SAMPLES_TTL_SECONDS)
    if cached is not None:
        return cached

    gen = current_generation()

    cols = (
        t.images.c._id,
        t.images.c.gen_group_id,
        t.images.c.thumb_key,
        t.images.c.width,
        t.images.c.height,
        t.images.c.blurhash,
    )
    out: list[dict] = []
    seen: set[str] = set()
    # `any:<base>` is the tag from every source; any other id is that one kind.
    match = (
        t.image_tags.c.base == pin_key(tag)
        if image_tags.is_any(tag)
        else t.image_tags.c.tag == tag
    )

    async with async_conn() as conn:
        # A pinned thumbnail (tag_meta) leads the mosaic when present.
        pinned = (
            await conn.execute(
                sa.select(t.tag_meta.c.thumb_image_id).where(
                    t.tag_meta.c.tag == pin_key(tag)
                )
            )
        ).scalar()
        if pinned:
            row = (
                await conn.execute(
                    sa.select(*cols).where(
                        t.images.c._id == pinned,
                        image_tags.not_quarantined(),
                        sa.exists(
                            sa.select(1).where(
                                t.image_tags.c.image_id == t.images.c._id, match
                            )
                        ),
                    )
                )
            ).first()
            if row is not None:
                seen.add(row._id)
                out.append(dict(row._mapping))
        batches = {out[0]["gen_group_id"]} - {None} if out else set()

        # A fixed per-tag shuffle (`_shuffled`) varies images across tags and
        # keeps each mosaic put across refreshes. Full scan + sort of the
        # matching rows, but the result is cached (TTL) and per-tag match sets
        # are small. Over-fetch to backfill any collision with the pinned image.
        # Quarantined images never show, pinned or not.
        remaining = per - len(out)
        if remaining > 0:
            rows = (
                await conn.execute(
                    # EXISTS, not a join: an `any:` match has a row per
                    # source, and one image twice would leave the mosaic short.
                    sa.select(*cols)
                    .where(
                        image_tags.not_quarantined(),
                        sa.exists(
                            sa.select(1).where(
                                t.image_tags.c.image_id == t.images.c._id, match
                            )
                        ),
                    )
                    .order_by(_shuffled(tag))
                    # Room to skip a batch's other images.
                    .limit((remaining + 1) * SAMPLE_SPREAD)
                )
            ).fetchall()
            fresh = [r for r in rows if r._id not in seen]
            again = []
            for row in fresh:
                group = row.gen_group_id
                if group is not None and group in batches:
                    again.append(row)
                    continue
                if group is not None:
                    batches.add(group)
                out.append(dict(row._mapping))
                if len(out) >= per:
                    break
            for row in again[: max(0, per - len(out))]:
                out.append(dict(row._mapping))

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


# --- Tags page ----------------------------------------------------------------

SOURCES = ("all", "ai", "prompt", "manual")


def _source_clause(source: str):
    """Restrict ``image_tags`` rows to one source (``all``: no restriction)."""
    tag = t.image_tags.c.tag
    manual = tag.like(f"{image_tags.MANUAL_PREFIX}%")
    prompt = tag.like(f"{image_tags.PROMPT_PREFIX}%")
    if source == "manual":
        return manual
    if source == "prompt":
        return prompt
    if source == "ai":
        return sa.and_(~manual, ~prompt)
    return sa.true()


async def browse(source: str = "all") -> list[dict]:
    """One entry per tag name for the Tags page, the sources it was found by
    merged (``source`` keeps only one): distinct images, character or general,
    when it was last used (newest file time) and its cover (the image its
    mosaic leads with)."""
    cache_key = f"browse:{source}"
    cached = _read(_tags_cache, cache_key, _TAGS_TTL_SECONDS)
    if cached is not None:
        return cached

    gen = current_generation()
    result = await _browse(source)
    _store(_tags_cache, cache_key, gen, result)
    return result


async def character_rows() -> list[dict]:
    """:func:`browse` rows (every source) of the tags that may be characters:
    the listed names, the bare-name candidates and the tags the user set a
    kind for (or made by hand), whatever their case. The same counts and
    covers, without aggregating the rest of the library. Not cached: the
    caller caches what it builds from them."""
    vocab = await tag_categories.load()
    async with async_conn() as conn:
        set_by_user = (
            await conn.execute(sa.select(sa.func.lower(t.characters.c.tag)))
        ).scalars()
        maybe = vocab.names | vocab.candidates.keys() | set(set_by_user)
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
        .where(image_tags.not_quarantined())
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
            _source_clause(source),
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
        sa.select(agg.c.base, _seed_sql(agg.c.base).label("seed"))
        .cte("seeds")
        .prefix_with("MATERIALIZED")
    )
    # The cover, by the mosaic's own rule (samples_for_tag): the pinned image
    # if it is visible and carries the tag, else the first of the shuffle.
    # The shuffle key is never negative, so a pin's -1 always wins.
    key = sa.case(
        (rc.pinned == sa.true(), -1),
        else_=(rc.rid * _HASH_MUL + seeds.c.seed) % _HASH_MOD,
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
        characters = await _characters(conn, vocab, {r.base for r in rows})

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


async def _characters(
    conn, vocab: tag_categories.Vocab, bases: set[str]
) -> frozenset[str]:
    """The character names (lowercased) for ``bases``: listed ones, plus the
    bare-name candidates the library backs (``tag_categories.confirmed``),
    counting visible images only, like everything else on the Tags page. The
    user's say on a character page (``characters.kind``) beats both."""
    names = set(await _listed_characters(conn, vocab, bases))
    overrides = (
        await conn.execute(
            sa.select(t.characters.c.tag, t.characters.c.kind).where(
                t.characters.c.kind.isnot(None)
            )
        )
    ).fetchall()
    for tag, kind in overrides:
        if kind == "character":
            names.add(tag.lower())
        else:
            # Not a character under any name: its bare name goes with it.
            gone = {tag.lower()} | {
                bare for bare, c in vocab.candidates.items() if c.full == tag.lower()
            }
            names -= gone
    return frozenset(names)


async def _listed_characters(
    conn, vocab: tag_categories.Vocab, bases: set[str]
) -> frozenset[str]:
    names = set(vocab.names)
    spellings: dict[str, set[str]] = {}
    for base in bases:
        if base.lower() in vocab.candidates:
            spellings.setdefault(base.lower(), set()).add(base)
    if not spellings:
        return frozenset(names)
    by_name = {key: vocab.candidates[key] for key in spellings}
    evidence = {c.series for c in by_name.values()} | {c.full for c in by_name.values()}
    it, other = t.image_tags, t.image_tags.alias("other")
    wanted = [b for group in spellings.values() for b in group]
    visible = sa.exists(
        sa.select(1).where(
            t.images.c._id == it.c.image_id, image_tags.not_quarantined()
        )
    )
    # One pass: every (candidate, image, evidence-or-NULL) row.
    rows = (
        await conn.execute(
            sa.select(it.c.base, it.c.image_id, other.c.base)
            .select_from(
                it.outerjoin(
                    other,
                    sa.and_(
                        other.c.image_id == it.c.image_id,
                        other.c.base.in_(evidence),
                    ),
                )
            )
            .where(it.c.base.in_(wanted), visible)
        )
    ).fetchall()
    images: dict[str, set[str]] = {}
    backed: dict[str, set[str]] = {}
    for base, image_id, found in rows:
        key = base.lower()
        images.setdefault(key, set()).add(image_id)
        cand = by_name[key]
        if found in (cand.series, cand.full):
            backed.setdefault(key, set()).add(image_id)
    for key, ids in images.items():
        if tag_categories.confirmed(len(ids), len(backed.get(key, ()))):
            names.add(key)
    return frozenset(names)


_RELATED = 40


def image_ids(bases: list[str], source: str = "all"):
    """The visible images carrying any of ``bases``, as a subquery."""
    it = t.image_tags
    visible = sa.exists(
        sa.select(1).where(
            t.images.c._id == it.c.image_id, image_tags.not_quarantined()
        )
    )
    return (
        sa.select(it.c.image_id)
        .where(it.c.base.in_(bases), _source_clause(source), visible)
        .distinct()
        .scalar_subquery()
    )


async def detail(
    base: str, source: str = "all", aliases: tuple[str, ...] = ()
) -> dict | None:
    """What the Tags page panel shows for one tag (``None`` when no image has
    it): counts by source, first and last use, images per month, and what the
    images were made with (loras with their usual weight, positive-prompt
    embeddings, workflow signatures) or tagged with besides. ``aliases`` are
    other names of the same thing (a character's bare name), counted as one.
    Related tags come untrimmed (``_RELATED``) so the caller can drop its
    boilerplate and still have some left."""
    it = t.image_tags
    bases = [base, *aliases]
    visible = sa.exists(
        sa.select(1).where(
            t.images.c._id == it.c.image_id, image_tags.not_quarantined()
        )
    )
    ids = image_ids(bases, source)
    in_ids = t.images.c._id.in_(ids)
    month = sa.func.strftime("%Y-%m", t.images.c.mtime, "unixepoch", "localtime")
    vocab = await tag_categories.load()  # a file read: before taking a connection
    async with async_conn() as conn:
        span = (
            await conn.execute(
                sa.select(
                    sa.func.count(),
                    sa.func.min(t.images.c.mtime),
                    sa.func.max(t.images.c.mtime),
                ).where(in_ids)
            )
        ).one()
        if not span[0]:
            return None
        kinds = (
            await conn.execute(
                sa.select(it.c.tag, sa.func.count())
                .where(it.c.base.in_(bases), visible)
                .group_by(it.c.tag)
            )
        ).fetchall()
        months = (
            await conn.execute(
                sa.select(month.label("month"), sa.func.count().label("count"))
                .where(in_ids, t.images.c.mtime.isnot(None))
                .group_by(month)
                .order_by(month)
            )
        ).fetchall()
        loras = (
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
        emb = t.image_embeddings
        emb_count = sa.func.count(sa.distinct(emb.c.image_id))
        embeddings = (
            await conn.execute(
                sa.select(emb.c.name, emb_count.label("count"))
                .where(emb.c.image_id.in_(ids), emb.c.negative.is_(False))
                .group_by(emb.c.name)
                .order_by(emb_count.desc(), emb.c.name)
                .limit(5)
            )
        ).fetchall()
        sigs = (
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
        related = (
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
        pin = (await _pins(conn, {base})).get(base)
        characters = await _characters(conn, vocab, {base})

    sources = {"ai": 0, "prompt": 0, "manual": 0}
    for tag, n in kinds:
        kind = (
            "manual"
            if image_tags.is_manual(tag)
            else "prompt"
            if image_tags.is_prompt(tag)
            else "ai"
        )
        sources[kind] += n
    return {
        "tag": base,
        "count": span[0],
        "category": tag_categories.category(base, characters),
        "first_used": span[1],
        "last_used": span[2],
        "sources": sources,
        "months": [{"month": m, "count": n} for m, n in months],
        "loras": [
            {
                "name": r.name,
                "count": r.count,
                "strength": None if r.strength is None else round(r.strength, 2),
            }
            for r in loras
        ],
        "embeddings": [{"name": r.name, "count": r.count} for r in embeddings],
        "workflows": [{"sig": r.sig, "count": r.count} for r in sigs],
        "related": [{"tag": r.base, "count": r.count} for r in related],
        "thumb_image_id": pin,
    }
