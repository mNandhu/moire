"""Unit tests for the image-feed query module: the seam the router used to bury.

``FeedFilter`` validation and ``feed_where`` are now testable without FastAPI;
end-to-end behaviour stays covered by test_feed_integration.py.
"""

import pytest

import sqlalchemy as sa

from moire.database import schema as t
from moire.services.image_feed import (
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
