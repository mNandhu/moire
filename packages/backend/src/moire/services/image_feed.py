"""Image feed: the cursor-paged stream of Images matching an Image filter.

The single owner of how a filter becomes SQL. A :class:`FeedFilter` validates its
own inputs on construction (raising :class:`FeedFilterError`, which the router maps
to HTTP 422); :func:`feed_where` turns it into a WHERE clause; :func:`list_feed`
and :func:`list_groups` run the cursor-paged feed and the batch-collapsed grouped
view. Keeping validation + SQL here (not in the router) makes the feed testable
without FastAPI and lets the feed and grouped view share one builder so they can
never drift.

Callers hand in a filter and get rows back. Thumbnail-URL decoration stays in the
router because it knows the media route shape; everything else lives here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import image_shapes, image_tags, workflow_family
from .outfit_wear import WearRule, wear_condition
from .tag_names import canonical_name


class FeedFilterError(ValueError):
    """Invalid feed-filter input. The router maps this to HTTP 422."""


# Columns the grid needs (kept minimal for payload size).
#
# The triage flags (rating / quarantined / has_ai_tags) are here because the
# grid draws them on every tile: the gallery is where images get scored,
# quarantined and tagged, so "what have I already done to this one" has to be
# visible without opening it. They are indexed scalars on `images`, a bool and
# a short string per row, so the payload cost is far below a second request.
FEED_COLUMNS = (
    t.images.c._id,
    t.images.c.path,
    t.images.c.width,
    t.images.c.height,
    t.images.c.thumb_key,
    t.images.c.blurhash,
    t.images.c.score,
    t.images.c.rating,
    t.images.c.quarantined,
    t.images.c.has_ai_tags,
    t.images.c.mtime,
)

# Names of the projected columns, so callers that build result dicts by hand
# stay in step with FEED_COLUMNS. `list_groups` used to enumerate its nine keys
# literally, which meant a column added here reached the flat feed and silently
# skipped the grouped view; the grid then drew tiles with no rating, no
# quarantine badge and no untagged marker in one of the two gallery views.
FEED_KEYS = tuple(c.name for c in FEED_COLUMNS)


# Feed orders. `mtime` is the file's modification time, the best available
# proxy for when an image was generated (a copy or move can reset it). Every
# order ends in `_id` so it is total and cursor paging stable, and runs one
# direction throughout so a single row-value comparison pages it. The
# coalesces keep rows without an mtime (or score) pageable; the literal 0, not
# a bound parameter, keeps each expression identical to its index's in
# schema.py so SQLite can walk the index.
SORT_KEY = sa.func.coalesce(t.images.c.mtime, sa.literal_column("0"))
SCORE_KEY = sa.func.coalesce(t.images.c.score, sa.literal_column("0"))

# name -> (sort keys before _id, descending?). "top" is best scored first,
# newest first among equals (so unscored images read as the newest feed).
SORTS: dict[str, tuple[tuple, bool]] = {
    "newest": ((SORT_KEY,), True),
    "oldest": ((SORT_KEY,), False),
    "top": ((SCORE_KEY, SORT_KEY), True),
}


def _directed(cols, sort: str) -> list:
    """``cols`` (the sort keys then ``_id``) in ``sort``'s direction."""
    desc = SORTS[sort][1]
    return [c.desc() if desc else c.asc() for c in cols]


def encode_cursor(row, sort: str = "newest") -> str:
    """The cursor after ``row``: its sort-key values and id joined by ``|``,
    ``"<mtime>|<_id>"`` or ``"<score>|<mtime>|<_id>"`` for "top". Built by the
    server from the values it sorted on (``sort_0``, ``sort_1`` columns), never
    by the client from cached items, which local edits (a new score) can
    change. ``repr`` round-trips floats exactly."""
    n = len(SORTS[sort][0])
    values = [float(row[f"sort_{i}"]) for i in range(n)]
    return "|".join([*(repr(v) for v in values), row["_id"]])


def parse_cursor(cursor: str, sort: str = "newest") -> tuple[list[float], str]:
    """Split a cursor from :func:`encode_cursor` into its sort-key values and
    id. The id comes last and may itself contain ``|``. FeedFilterError when
    malformed, including non-finite values (``nan`` binds as NULL and would
    silently end the feed)."""
    n = len(SORTS[sort][0])
    parts = cursor.split("|", n)
    try:
        if len(parts) != n + 1 or not parts[-1]:
            raise ValueError
        values = [float(p) for p in parts[:n]]
        if not all(math.isfinite(v) for v in values):
            raise ValueError
        return values, parts[-1]
    except ValueError:
        raise FeedFilterError("malformed cursor") from None


@dataclass(frozen=True)
class FeedFilter:
    """A validated Image filter. Constructing one validates every axis; invalid
    input raises :class:`FeedFilterError` so the same rules guard the feed, the
    grouped view, and any future caller."""

    tags: list[str] | None = None
    logic: str = "and"
    library_id: str | None = None
    no_tags: int | None = None
    no_ai_tags: int | None = None
    ai_tagged: int | None = None
    quarantined: int | None = None
    needs_mapping: int | None = None
    pterms: list[str] | None = None
    plogic: str = "and"
    model: list[str] | None = None
    lora: list[str] | None = None
    embedding: list[str] | None = None
    # Size presets (`image_shapes`), any of them.
    shape: list[str] | None = None
    min_w: int | None = None
    max_w: int | None = None
    min_h: int | None = None
    max_h: int | None = None
    group_id: str | None = None
    workflow_id: str | None = None
    workflow_sig: str | None = None
    # Outfits the image wears (saved ids, or `default:<character>`), each.
    outfit: list[str] | None = None
    sort: str = "newest"
    # The family's signatures, resolved from `workflow_id` by `_resolved`
    # before the query is built (not a user input).
    family_sigs: tuple[str, ...] | None = None
    # Each outfit's `outfit_wear.WearRule`, resolved from `outfit` by `_resolved`;
    # None for an unknown outfit (matches nothing).
    outfit_rules: tuple[WearRule | None, ...] | None = None
    # The images of the filter's rarest tag group or prompt term, when that
    # is few enough to drive the query by id (`_drive_by_rarest`).
    driver_ids: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        if self.sort not in SORTS:
            raise FeedFilterError(f"sort must be one of {', '.join(SORTS)}")
        if self.logic not in ("and", "or"):
            raise FeedFilterError("logic must be 'and' or 'or'")
        if self.plogic not in ("and", "or"):
            raise FeedFilterError("plogic must be 'and' or 'or'")
        if self.ai_tagged == 1 and (self.no_ai_tags == 1 or self.no_tags == 1):
            raise FeedFilterError(
                "ai_tagged=1 cannot be combined with no_ai_tags or no_tags"
            )
        if self.outfit and len(self.outfit) > 10:
            raise FeedFilterError("too many outfits (max 10)")
        if self.tags:
            if len(self.tags) > 100:
                raise FeedFilterError("too many tags (max 100)")
            for tag in self.tags:
                if not isinstance(tag, str) or len(tag) == 0:
                    raise FeedFilterError("tags must be non-empty")
                if len(tag) > 128:
                    raise FeedFilterError("tag too long (max 128)")
            if self.no_tags == 1:
                raise FeedFilterError("no_tags=1 cannot be combined with tags filter")


def _tag_group_exists(ids: list[str]):
    """An EXISTS clause: the image carries at least one tag from ``ids``."""
    return sa.exists(
        sa.select(1).where(
            t.image_tags.c.image_id == t.images.c._id,
            t.image_tags.c.tag.in_(ids),
        )
    )


def feed_where(f: FeedFilter):
    """Build the SQL WHERE clause shared by the feed and the grouped view."""
    conds: list = []
    if f.driver_ids is not None:
        conds.append(t.images.c._id.in_(f.driver_ids))
    if f.tags:
        # `any:<base>` entries fan out to all sources; exact tags stay precise.
        # AND across groups, OR within each group: one EXISTS per group.
        # Either spelling finds a tag (`blue eyes` = `blue_eyes`), so a typed
        # tag or an old bookmarked URL still matches the canonical stored form.
        wanted = [image_tags.canonical_tag(tag) for tag in f.tags]
        for group in image_tags.tag_match_groups(wanted, f.logic):
            conds.append(_tag_group_exists(group))
        if f.no_ai_tags == 1:
            conds.append(t.images.c.has_ai_tags.is_(False))
    else:
        if f.no_tags == 1:
            conds.append(t.images.c.has_tags.is_(False))
        if f.no_ai_tags == 1:
            conds.append(t.images.c.has_ai_tags.is_(False))
    if f.ai_tagged == 1:
        conds.append(t.images.c.has_ai_tags.is_(True))
    if f.library_id:
        conds.append(t.images.c.library_id == f.library_id)
    # Quarantined images leave the default feed. Treat missing/NULL as not
    # quarantined so legacy rows still appear.
    if f.quarantined == 1:
        conds.append(t.images.c.quarantined.is_(True))
    else:
        conds.append(image_tags.not_quarantined())
    if f.needs_mapping == 1:
        conds.append(t.images.c.gen_workflow_sig.isnot(None))
        conds.append(t.images.c.gen_prompt.is_(None))
    if f.pterms:
        terms = [canonical_name(p.lower()) for p in f.pterms if p and p.strip()]
        if terms:
            if f.plogic == "or":
                conds.append(
                    sa.exists(
                        sa.select(1).where(
                            t.image_gen_terms.c.image_id == t.images.c._id,
                            t.image_gen_terms.c.term.in_(terms),
                        )
                    )
                )
            else:
                # $all: the image must carry every term.
                for term in terms:
                    conds.append(
                        sa.exists(
                            sa.select(1).where(
                                t.image_gen_terms.c.image_id == t.images.c._id,
                                t.image_gen_terms.c.term == term,
                            )
                        )
                    )
    if f.model:
        models = [m for m in f.model if m]
        if models:
            conds.append(t.images.c.gen_model.in_(models))
    if f.lora:
        # Every chosen lora must have been used (AND), like the tag filter.
        for name in {n for n in f.lora if n}:
            conds.append(
                sa.exists(
                    sa.select(1).where(
                        t.image_loras.c.image_id == t.images.c._id,
                        t.image_loras.c.name == name,
                    )
                )
            )
    if f.embedding:
        # Every chosen embedding must have been used, on either prompt side.
        for name in {n for n in f.embedding if n}:
            conds.append(
                sa.exists(
                    sa.select(1).where(
                        t.image_embeddings.c.image_id == t.images.c._id,
                        t.image_embeddings.c.name == name,
                    )
                )
            )
    if f.outfit:
        if f.outfit_rules is None:
            raise RuntimeError("outfit filter used before _resolved()")
        # An unknown outfit (None) matches nothing.
        conds += [wear_condition(r) if r else sa.false() for r in f.outfit_rules]
    if f.shape:
        conds.append(image_shapes.where(f.shape))
    if f.min_w is not None:
        conds.append(t.images.c.width >= f.min_w)
    if f.max_w is not None:
        conds.append(t.images.c.width <= f.max_w)
    if f.min_h is not None:
        conds.append(t.images.c.height >= f.min_h)
    if f.max_h is not None:
        conds.append(t.images.c.height <= f.max_h)
    if f.workflow_id:
        if f.family_sigs is None:
            raise RuntimeError("workflow filter used before _resolved()")
        conds.append(t.images.c.gen_workflow_sig.in_(f.family_sigs))
    if f.workflow_sig:
        conds.append(t.images.c.gen_workflow_sig == f.workflow_sig)
    # Drill into one batch's members (used by the grouped view's expand).
    if f.group_id:
        conds.append(t.images.c.gen_group_id == f.group_id)
    return sa.and_(*conds) if conds else sa.true()


async def _resolved(conn, f: FeedFilter) -> FeedFilter:
    """``f`` with its workflow family expanded to signatures: one small lookup
    up front, so the page query filters on a plain indexed ``IN`` list."""
    if f.workflow_id and f.family_sigs is None:
        sigs = await workflow_family.family_sigs(conn, f.workflow_id)
        f = replace(f, family_sigs=sigs)
    if f.outfit and f.outfit_rules is None:
        from . import outfits

        rules = [await outfits.wear_rule(o) for o in dict.fromkeys(f.outfit) if o]
        f = replace(f, outfit_rules=tuple(rules))
    return await _drive_by_rarest(conn, f)


# Below this many matches, fetching a tag's ids first beats walking `images`
# in sort order with an EXISTS probe per row. Measured break-even was ~350
# matches on a 3.9k-image library and ~1300 on 30k; past it the id list
# costs more (about 10 ms per 1000 ids) than the walk it replaces.
_RARE = 300


async def _drive_by_rarest(conn, f: FeedFilter) -> FeedFilter:
    """``f`` driven by the ids of its rarest tag group or prompt term, when
    that is rare. SQLite walks ``images`` in sort order and probes each row's
    EXISTS filters, so a tag on 30 of 30k images costs a full walk; an
    ``_id IN (...)`` list of those 30 is a handful of lookups. Every group is
    ANDed into the filter, so its images are a superset of the result and the
    other conditions still apply."""
    if f.driver_ids is not None:
        return f
    groups = []  # (table, column, values)
    if f.tags:
        wanted = [image_tags.canonical_tag(tag) for tag in f.tags]
        for grp in image_tags.tag_match_groups(wanted, f.logic):
            groups.append((t.image_tags, t.image_tags.c.tag, grp))
    if f.pterms and f.plogic == "and":
        for term in [canonical_name(p.lower()) for p in f.pterms if p and p.strip()]:
            groups.append((t.image_gen_terms, t.image_gen_terms.c.term, [term]))
    best: list[str] | None = None
    for tbl, col, vals in groups:
        # Distinct ids, capped: one query both sizes the group and, when it
        # is rare, is the id list itself.
        ids = list(
            (
                await conn.execute(
                    sa.select(tbl.c.image_id)
                    .where(col.in_(vals))
                    .distinct()
                    .limit(_RARE + 1)
                )
            ).scalars()
        )
        if len(ids) <= _RARE and (best is None or len(ids) < len(best)):
            best = ids
            if len(ids) <= 1:
                break  # can't get rarer; skip probing the other groups
    if best is None:
        return f
    return replace(f, driver_ids=tuple(best))


async def list_ids(f: FeedFilter, *, limit: int) -> list[str]:
    """Every image ``f`` matches (up to ``limit``), in feed order."""
    async with async_conn() as conn:
        f = await _resolved(conn, f)
        keys, _ = SORTS[f.sort]
        stmt = (
            sa.select(t.images.c._id)
            .where(feed_where(f))
            .order_by(*_directed([*keys, t.images.c._id], f.sort))
            .limit(limit)
        )
        return list((await conn.execute(stmt)).scalars())


async def list_feed(
    f: FeedFilter, *, cursor: str | None, limit: int, offset: int
) -> tuple[list[dict], str | None]:
    """The cursor-paged feed in ``f.sort`` order (see :data:`SORTS`): rows
    after ``cursor``, plus the cursor for the page after these (None when the
    page is empty)."""
    async with async_conn() as conn:
        f = await _resolved(conn, f)
    keys, desc = SORTS[f.sort]
    stmt = sa.select(
        *FEED_COLUMNS, *(k.label(f"sort_{i}") for i, k in enumerate(keys))
    ).where(feed_where(f))
    if cursor:
        values, image_id = parse_cursor(cursor, f.sort)
        row = sa.tuple_(*keys, t.images.c._id)
        after = sa.tuple_(*(sa.literal(v) for v in values), sa.literal(image_id))
        stmt = stmt.where(row < after if desc else row > after)
        # SQLite won't seek an index from a row-value comparison, so a deep
        # page walked every row above it. The redundant range on the leading
        # key (implied by the row compare) lets it seek straight there.
        lead = sa.literal(values[0])
        stmt = stmt.where(keys[0] <= lead if desc else keys[0] >= lead)
    stmt = stmt.order_by(*_directed([*keys, t.images.c._id], f.sort)).limit(limit)
    if not cursor and offset:
        stmt = stmt.offset(offset)
    async with async_conn() as conn:
        rows = [dict(r._mapping) for r in (await conn.execute(stmt)).fetchall()]
    next_cursor = encode_cursor(rows[-1], f.sort) if rows else None
    return [{k: r[k] for k in FEED_KEYS} for r in rows], next_cursor


async def list_groups(f: FeedFilter, *, offset: int, limit: int) -> list[dict]:
    """Batch-collapsed view: images sharing a ``gen_group_id`` fold into one entry
    (the member first in ``f.sort`` order is the representative, plus a count).
    Ungrouped images stand alone. Grouping is a full aggregation, so it spans
    page boundaries. Batches order by their representative."""
    # Ungrouped images key on their own _id so each stands alone (never a single
    # giant "null" bucket). Window functions count + pick the representative in
    # one pass, spanning page boundaries.
    async with async_conn() as conn:
        f = await _resolved(conn, f)
    gkey = sa.func.coalesce(t.images.c.gen_group_id, t.images.c._id)
    sub = (
        sa.select(
            *FEED_COLUMNS,
            t.images.c.gen_group_id.label("group_id"),
            sa.func.row_number()
            .over(
                partition_by=gkey,
                order_by=_directed([*SORTS[f.sort][0], t.images.c._id], f.sort),
            )
            .label("rn"),
            sa.func.count().over(partition_by=gkey).label("group_count"),
            *(k.label(f"sort_{i}") for i, k in enumerate(SORTS[f.sort][0])),
        )
        .where(feed_where(f))
        .subquery()
    )
    stmt = (
        sa.select(sub)
        .where(sub.c.rn == 1)
        .order_by(
            *_directed(
                [
                    *(sub.c[f"sort_{i}"] for i in range(len(SORTS[f.sort][0]))),
                    sub.c._id,
                ],
                f.sort,
            )
        )
        .offset(offset)
        .limit(limit)
    )
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                **{k: getattr(r, k) for k in FEED_KEYS},
                "group_id": r.group_id,
                "group_count": r.group_count,
            }
        )
    return out
