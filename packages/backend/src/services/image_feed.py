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
)

# Names of the projected columns, so callers that build result dicts by hand
# stay in step with FEED_COLUMNS. `list_groups` used to enumerate its nine keys
# literally, which meant a column added here reached the flat feed and silently
# skipped the grouped view; the grid then drew tiles with no rating, no
# quarantine badge and no untagged marker in one of the two gallery views.
FEED_KEYS = tuple(c.name for c in FEED_COLUMNS)


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

    def __post_init__(self) -> None:
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
    # Drill into one batch's members (used by the grouped view's expand).
    if f.group_id:
        conds.append(t.images.c.gen_group_id == f.group_id)
    return sa.and_(*conds) if conds else sa.true()


async def list_feed(
    f: FeedFilter, *, cursor: str | None, limit: int, offset: int
) -> list[dict]:
    """The cursor-paged feed: rows with ``_id < cursor`` in descending id order."""
    stmt = sa.select(*FEED_COLUMNS).where(feed_where(f))
    if cursor:
        stmt = stmt.where(t.images.c._id < cursor)
    stmt = stmt.order_by(t.images.c._id.desc()).limit(limit)
    if not cursor and offset:
        stmt = stmt.offset(offset)
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [dict(r._mapping) for r in rows]


async def list_groups(f: FeedFilter, *, offset: int, limit: int) -> list[dict]:
    """Batch-collapsed view: images sharing a ``gen_group_id`` fold into one entry
    (newest member is the representative, plus a count). Ungrouped images stand
    alone. Grouping is a full aggregation, so it spans page boundaries."""
    # Ungrouped images key on their own _id so each stands alone (never a single
    # giant "null" bucket). Window functions count + pick the representative in
    # one pass, spanning page boundaries.
    gkey = sa.func.coalesce(t.images.c.gen_group_id, t.images.c._id)
    sub = (
        sa.select(
            *FEED_COLUMNS,
            t.images.c.gen_group_id.label("group_id"),
            sa.func.row_number()
            .over(partition_by=gkey, order_by=t.images.c._id.desc())
            .label("rn"),
            sa.func.count().over(partition_by=gkey).label("group_count"),
        )
        .where(feed_where(f))
        .subquery()
    )
    stmt = (
        sa.select(sub)
        .where(sub.c.rn == 1)
        .order_by(sub.c._id.desc())
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
