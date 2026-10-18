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

from dataclasses import dataclass

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import image_tags


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


def _order(sort: str, id_col=None):
    keys, desc = SORTS[sort]
    cols = (*keys, id_col if id_col is not None else t.images.c._id)
    return [c.desc() if desc else c.asc() for c in cols]


def parse_cursor(cursor: str, sort: str = "newest") -> tuple[list[float], str]:
    """Split a cursor, the one the frontend builds from the last item it has
    (``nextCursorOf``), into its sort-key values and id: ``"<mtime>|<_id>"``,
    or ``"<score>|<mtime>|<_id>"`` for "top". The id comes last and may itself
    contain ``|``. FeedFilterError when malformed."""
    n = len(SORTS[sort][0])
    parts = cursor.split("|", n)
    try:
        if len(parts) != n + 1 or not parts[-1]:
            raise ValueError
        return [float(p) for p in parts[:n]], parts[-1]
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
    quarantined: int | None = None
    needs_mapping: int | None = None
    pterms: list[str] | None = None
    plogic: str = "and"
    model: list[str] | None = None
    min_w: int | None = None
    max_w: int | None = None
    min_h: int | None = None
    max_h: int | None = None
    group_id: str | None = None
    workflow_id: str | None = None
    workflow_sig: str | None = None
    sort: str = "newest"

    def __post_init__(self) -> None:
        if self.sort not in SORTS:
            raise FeedFilterError(f"sort must be one of {', '.join(SORTS)}")
        if self.logic not in ("and", "or"):
            raise FeedFilterError("logic must be 'and' or 'or'")
        if self.plogic not in ("and", "or"):
            raise FeedFilterError("plogic must be 'and' or 'or'")
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


def _family_sigs(workflow_id: str):
    """Signatures in a workflow family: those whose sample image (the newest
    by id, as on the Rules page) embeds an editor graph with this ``id``. So a
    family filter matches exactly the versions Rules groups under it, and new
    versions join it as they are scanned. Uncorrelated, so SQLite runs it once
    per query; json_extract only touches one row per signature."""
    sample = (
        sa.select(sa.func.max(t.images.c._id))
        .where(t.images.c.gen_workflow_sig.isnot(None))
        .group_by(t.images.c.gen_workflow_sig)
    )
    return (
        sa.select(t.images.c.gen_workflow_sig)
        .join(t.image_gen_raw, t.image_gen_raw.c._id == t.images.c._id)
        .where(
            t.images.c._id.in_(sample),
            sa.func.json_extract(t.image_gen_raw.c.raw, "$.workflow.id") == workflow_id,
        )
    )


def feed_where(f: FeedFilter):
    """Build the SQL WHERE clause shared by the feed and the grouped view."""
    conds: list = []
    if f.tags:
        # `any:<base>` entries fan out to all sources; exact tags stay precise.
        # AND across groups, OR within each group: one EXISTS per group.
        for group in image_tags.tag_match_groups(f.tags, f.logic):
            conds.append(_tag_group_exists(group))
        if f.no_ai_tags == 1:
            conds.append(t.images.c.has_ai_tags.is_(False))
    else:
        if f.no_tags == 1:
            conds.append(t.images.c.has_tags.is_(False))
        if f.no_ai_tags == 1:
            conds.append(t.images.c.has_ai_tags.is_(False))
    if f.library_id:
        conds.append(t.images.c.library_id == f.library_id)
    # Quarantined images leave the default feed. Treat missing/NULL as not
    # quarantined so legacy rows still appear.
    if f.quarantined == 1:
        conds.append(t.images.c.quarantined.is_(True))
    else:
        conds.append(sa.func.coalesce(t.images.c.quarantined, False).is_(False))
    if f.needs_mapping == 1:
        conds.append(t.images.c.gen_workflow_sig.isnot(None))
        conds.append(t.images.c.gen_prompt.is_(None))
    if f.pterms:
        terms = [p.strip().lower() for p in f.pterms if p and p.strip()]
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
    if f.min_w is not None:
        conds.append(t.images.c.width >= f.min_w)
    if f.max_w is not None:
        conds.append(t.images.c.width <= f.max_w)
    if f.min_h is not None:
        conds.append(t.images.c.height >= f.min_h)
    if f.max_h is not None:
        conds.append(t.images.c.height <= f.max_h)
    if f.workflow_id:
        conds.append(t.images.c.gen_workflow_sig.in_(_family_sigs(f.workflow_id)))
    if f.workflow_sig:
        conds.append(t.images.c.gen_workflow_sig == f.workflow_sig)
    # Drill into one batch's members (used by the grouped view's expand).
    if f.group_id:
        conds.append(t.images.c.gen_group_id == f.group_id)
    return sa.and_(*conds) if conds else sa.true()


async def list_feed(
    f: FeedFilter, *, cursor: str | None, limit: int, offset: int
) -> list[dict]:
    """The cursor-paged feed in ``f.sort`` order (see :data:`SORTS`): rows
    after ``cursor`` (see :func:`parse_cursor`)."""
    stmt = sa.select(*FEED_COLUMNS).where(feed_where(f))
    if cursor:
        values, image_id = parse_cursor(cursor, f.sort)
        keys, desc = SORTS[f.sort]
        row = sa.tuple_(*keys, t.images.c._id)
        after = sa.tuple_(*(sa.literal(v) for v in values), sa.literal(image_id))
        stmt = stmt.where(row < after if desc else row > after)
    stmt = stmt.order_by(*_order(f.sort)).limit(limit)
    if not cursor and offset:
        stmt = stmt.offset(offset)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [dict(r._mapping) for r in rows]


def _order_sub(sub, sort: str):
    keys, desc = SORTS[sort]
    cols = [sub.c[f"sort_{i}"] for i in range(len(keys))] + [sub.c._id]
    return [c.desc() if desc else c.asc() for c in cols]


async def list_groups(f: FeedFilter, *, offset: int, limit: int) -> list[dict]:
    """Batch-collapsed view: images sharing a ``gen_group_id`` fold into one entry
    (the member first in ``f.sort`` order is the representative, plus a count).
    Ungrouped images stand alone. Grouping is a full aggregation, so it spans
    page boundaries. Batches order by their representative."""
    # Ungrouped images key on their own _id so each stands alone (never a single
    # giant "null" bucket). Window functions count + pick the representative in
    # one pass, spanning page boundaries.
    gkey = sa.func.coalesce(t.images.c.gen_group_id, t.images.c._id)
    sub = (
        sa.select(
            *FEED_COLUMNS,
            t.images.c.gen_group_id.label("group_id"),
            sa.func.row_number()
            .over(partition_by=gkey, order_by=_order(f.sort))
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
            *_order_sub(sub, f.sort),
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
