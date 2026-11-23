"""Unit tests for the image-feed query module: the seam the router used to bury.

``FeedFilter`` validation and ``feed_where`` are now testable without FastAPI;
end-to-end behaviour stays covered by test_feed_integration.py.
"""

import random

import pytest

import sqlalchemy as sa

from moire.database import db, schema as t
from moire.services.images import feed as image_feed
from moire.services.images.feed import (
    SORTS,
    FeedFilter,
    FeedFilterError,
    _directed,
    feed_where,
)


def test_defaults_are_valid():
    f = FeedFilter()
    assert f.logic == "and" and f.plogic == "and"
    # No-op filter still produces a usable clause (quarantine guard is always on).
    assert feed_where(f) is not None


@pytest.mark.parametrize("bad", ["xor", "", "AND"])
def test_invalid_logic_rejected(bad):
    with pytest.raises(FeedFilterError):
        FeedFilter(logic=bad)


@pytest.mark.parametrize("bad", ["xor", "nope"])
def test_invalid_plogic_rejected(bad):
    with pytest.raises(FeedFilterError):
        FeedFilter(plogic=bad)


def test_too_many_tags_rejected():
    with pytest.raises(FeedFilterError):
        FeedFilter(tags=[str(i) for i in range(101)])


def test_empty_tag_rejected():
    with pytest.raises(FeedFilterError):
        FeedFilter(tags=["ok", ""])


def test_overlong_tag_rejected():
    with pytest.raises(FeedFilterError):
        FeedFilter(tags=["x" * 129])


def test_no_tags_with_tags_filter_rejected():
    with pytest.raises(FeedFilterError):
        FeedFilter(tags=["cat"], no_tags=1)


def test_valid_tags_accepted():
    f = FeedFilter(tags=["cat", "dog"], logic="or")
    assert f.tags == ["cat", "dog"]
    assert feed_where(f) is not None


def test_feed_where_is_pure_and_reusable():
    # Building twice yields independent clauses (no shared mutable state).
    f = FeedFilter(library_id="L1", min_w=100)
    a = feed_where(f)
    b = feed_where(f)
    assert str(a) == str(b)


@pytest.mark.parametrize(
    "sort,index",
    [
        ("newest", "ix_images_recent"),
        ("oldest", "ix_images_recent"),
        ("top", "ix_images_top"),
    ],
)
def test_first_page_walks_the_sort_index(sort, index):
    """The feed's order expressions must match schema.py's indexes exactly, or
    SQLite sorts every match instead of walking the index."""
    engine = sa.create_engine("sqlite://")
    t.metadata.create_all(engine)
    keys, _ = SORTS[sort]
    stmt = (
        sa.select(t.images.c._id)
        .where(feed_where(FeedFilter(sort=sort)))
        .order_by(*_directed([*keys, t.images.c._id], sort))
        .limit(50)
    )
    sql = str(stmt.compile(engine, compile_kwargs={"literal_binds": True}))
    with engine.connect() as conn:
        plan = " ".join(
            r[-1] for r in conn.exec_driver_sql("EXPLAIN QUERY PLAN " + sql)
        )
    assert index in plan, plan
    assert "TEMP B-TREE" not in plan, plan


def _seed_ties(seed):
    """300 images: most unscored (one big score tie), some NULL scores and
    mtimes, shared mtimes inside a score, two libraries."""
    rnd = random.Random(3)
    for i in range(300):
        seed(
            f"L{i % 2 + 1}:img{i:03d}",
            library_id=f"L{i % 2 + 1}",
            score=rnd.choice((0, 0, 0, 0, 0, None, 1, 2.5)),
            mtime=rnd.choice((None, 50.0, 50.0, *range(i * 3, i * 3 + 3))),
            quarantined=i % 17 == 0,
        )


@pytest.mark.parametrize("sort", list(SORTS))
@pytest.mark.parametrize("lib", [None, "L2"])
async def test_deep_page_in_a_tie_walks_the_sort_index(temp_db, seed, sort, lib):
    """A cursor deep inside the big score tie seeks into it: each part of the
    page walks the sort index, never sorting the tie."""
    _seed_ties(seed)
    f = FeedFilter(sort=sort, library_id=lib)
    depth = 60 if lib else 120
    page, cursor = await image_feed.list_feed(f, cursor=None, limit=depth, offset=0)
    assert cursor
    if sort == "top":
        assert page[-1]["score"] in (0, None)  # the cursor sits in the tie
    parts = image_feed._paged(
        sa.select(t.images.c._id).where(feed_where(f)),
        f,
        cursor=cursor,
        limit=20,
        offset=0,
    )
    index = ("ix_images_lib_" if lib else "ix_images_") + (
        "top" if sort == "top" else "recent"
    )
    assert len(parts) == len(SORTS[sort][0])
    with db.sync_conn() as conn:
        for i, stmt in enumerate(parts):
            sql = str(stmt.compile(conn, compile_kwargs={"literal_binds": True}))
            plan = " ".join(
                r[-1] for r in conn.exec_driver_sql("EXPLAIN QUERY PLAN " + sql)
            )
            assert f"USING INDEX {index} " in plan, plan
            assert "TEMP B-TREE" not in plan, plan
            if len(parts) > 1 and i == 0:
                # inside the tie: an equality on the score, a seek on mtime
                assert "<expr>=? AND <expr><?" in plan, plan


@pytest.mark.parametrize("sort", list(SORTS))
@pytest.mark.parametrize("lib", [None, "L2"])
@pytest.mark.parametrize("limit", [1, 7, 40])
async def test_cursor_walk_matches_the_full_order(temp_db, seed, sort, lib, limit):
    """Paging across tie boundaries (a tie spanning pages, a page ending on
    its last row) gives every row once, in the full sort's order."""
    _seed_ties(seed)
    f = FeedFilter(sort=sort, library_id=lib)
    expected = await image_feed.list_ids(f, limit=1000)
    seen, cursor = [], None
    while True:
        page, cursor = await image_feed.list_feed(
            f, cursor=cursor, limit=limit, offset=0
        )
        seen += [r["_id"] for r in page]
        if cursor is None:
            break
    assert seen == expected
