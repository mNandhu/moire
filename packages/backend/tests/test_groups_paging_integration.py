"""The grouped view's cursor paging (`feed.list_groups`) against the full
aggregation it replaced: walking every page with a small limit must give the
same representatives, in the same order, with the same counts, for every sort
and filter. Batches straddle page boundaries, scores tie, mtimes are missing."""

import random

import pytest
import sqlalchemy as sa

from moire.database import db, schema as t
from moire.services.images import feed as image_feed
from moire.services.images.feed import (
    FEED_COLUMNS,
    FEED_KEYS,
    SORTS,
    FeedFilter,
    _directed,
    _resolved,
    feed_where,
)
from moire.services.tags import sensitivity_filter


async def _reference(f: FeedFilter) -> list[dict]:
    """The old full aggregation: window functions over every match."""
    async with db.async_conn() as conn:
        f = await _resolved(conn, f)
    keys = SORTS[f.sort][0]
    gkey = sa.func.coalesce(t.images.c.gen_group_id, t.images.c._id)
    sub = (
        sa.select(
            *FEED_COLUMNS,
            t.images.c.gen_group_id.label("group_id"),
            sa.func.row_number()
            .over(
                partition_by=gkey,
                order_by=_directed([*keys, t.images.c._id], f.sort),
            )
            .label("rn"),
            sa.func.count().over(partition_by=gkey).label("group_count"),
            *(k.label(f"sort_{i}") for i, k in enumerate(keys)),
        )
        .where(feed_where(f))
        .subquery()
    )
    stmt = (
        sa.select(sub)
        .where(sub.c.rn == 1)
        .order_by(
            *_directed(
                [*(sub.c[f"sort_{i}"] for i in range(len(keys))), sub.c._id],
                f.sort,
            )
        )
    )
    async with db.async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    return [
        {
            **{k: getattr(r, k) for k in FEED_KEYS},
            "group_id": r.group_id,
            "group_count": r.group_count,
        }
        for r in rows
    ]


async def _walk(f: FeedFilter, limit: int) -> list[dict]:
    out, cursor = [], None
    while True:
        page, cursor = await image_feed.list_groups(f, cursor=cursor, limit=limit)
        out += page
        if len(page) < limit:
            return out
        assert cursor


@pytest.fixture
def library(seed):
    """~120 images: batches of 1-12 members, scores drawn from 0-3 (many
    ties), some mtimes missing or shared, tags, quarantine and ratings mixed,
    two libraries (a batch can span both)."""
    rnd = random.Random(7)
    n = 0
    for g in range(30):
        group = None if g % 6 == 0 else f"G{g}"
        for _ in range(rnd.randint(1, 12) if group else 1):
            n += 1
            seed(
                f"L{rnd.choice((1, 2))}:img{n:03d}",
                library_id=rnd.choice(("L1", "L2")),
                tags=tuple(
                    tag for tag in ("red", "blue", "solo") if rnd.random() < 0.4
                ),
                gen={"group_id": group, "prompt": "p"} if group else None,
                quarantined=rnd.random() < 0.1,
                score=rnd.choice((0, 0, 1, 2, 3)),
                rating=rnd.choice((None, "general", "explicit")),
                mtime=rnd.choice((None, 100.0, 100.0, *range(n * 10, n * 10 + 5))),
            )


FILTERS = [
    {},
    {"library_id": "L2"},
    {"tags": ["red"]},
    {"tags": ["red", "blue"], "logic": "or"},
    {"quarantined": 1},
    {"no_tags": 1},
    {"group_id": "largest"},
]


async def _largest_group() -> str:
    async with db.async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.images.c.gen_group_id)
                .where(t.images.c.gen_group_id.isnot(None))
                .group_by(t.images.c.gen_group_id)
                .order_by(sa.func.count().desc())
                .limit(1)
            )
        ).scalar_one()


@pytest.mark.parametrize("sort", list(SORTS))
@pytest.mark.parametrize("filt", FILTERS, ids=lambda d: ",".join(d) or "none")
@pytest.mark.parametrize("limit", [1, 3, 7])
async def test_cursor_walk_matches_full_aggregation(library, sort, filt, limit):
    if filt.get("group_id"):
        filt = {"group_id": await _largest_group()}
    f = FeedFilter(sort=sort, **filt)
    expected = await _reference(f)
    assert expected  # the filter matches something
    assert await _walk(f, limit) == expected


@pytest.mark.parametrize("sort", list(SORTS))
async def test_sensitivity_filter_applies_to_the_representative(
    library, monkeypatch, sort
):
    # On: only images rated general show. A batch's representative is its
    # first shown member, and its count counts shown members only.
    monkeypatch.setattr(sensitivity_filter, "_max", 0)
    f = FeedFilter(sort=sort)
    expected = await _reference(f)
    assert expected
    assert await _walk(f, 4) == expected


async def test_a_rare_tag_drives_by_id_and_still_matches(library, monkeypatch):
    # Force the id-driven path (`_drive_by_rarest`) for a common tag too.
    monkeypatch.setattr(image_feed, "_rare_cap", lambda n, all_rows: 10_000)
    f = FeedFilter(tags=["solo"], sort="top")
    assert await _walk(f, 2) == await _reference(f)


async def test_last_page_has_no_cursor(seed):
    seed("L1:a", mtime=1, gen={"group_id": "G", "prompt": "p"})
    seed("L1:b", mtime=2, gen={"group_id": "G", "prompt": "p"})
    page, cursor = await image_feed.list_groups(FeedFilter(), cursor=None, limit=5)
    # A short page is the last one.
    assert [(r["_id"], r["group_count"]) for r in page] == [("L1:b", 2)]
    assert cursor is None
    # A full last page still has one; the page after it is empty, no cursor.
    page, cursor = await image_feed.list_groups(FeedFilter(), cursor=None, limit=1)
    assert cursor is not None
    page, cursor = await image_feed.list_groups(FeedFilter(), cursor=cursor, limit=1)
    assert page == [] and cursor is None


async def test_route_pages_on_the_cursor_header(client, seed):
    for i in range(5):
        seed(f"L1:{i}", mtime=i, gen={"group_id": f"G{i % 2}", "prompt": "p"})
    seed("L1:solo", mtime=10)
    seen, cursor = [], None
    while True:
        params = {"limit": 1, **({"cursor": cursor} if cursor else {})}
        resp = await client.get("/images/groups", params=params)
        page = resp.json()
        if not page:
            assert "X-Next-Cursor" not in resp.headers
            break
        seen += [(r["_id"], r["group_count"]) for r in page]
        cursor = resp.headers["X-Next-Cursor"]
    assert seen == [("L1:solo", 1), ("L1:4", 3), ("L1:3", 2)]
    bad = await client.get("/images/groups", params={"cursor": "nope"})
    assert bad.status_code == 422


def _plan(sql: str) -> str:
    engine = sa.create_engine("sqlite://")
    t.metadata.create_all(engine)
    with engine.connect() as conn:
        return " ".join(
            r[-1] for r in conn.exec_driver_sql("EXPLAIN QUERY PLAN " + sql)
        )


@pytest.mark.parametrize(
    "sort,lib,walk,probe",
    [
        ("newest", None, "ix_images_recent", "ix_images_group_recent"),
        ("oldest", None, "ix_images_recent", "ix_images_group_recent"),
        ("top", None, "ix_images_top", "ix_images_group_top"),
        # The library's index ties with the batch's for the probe: pinned.
        ("newest", "L1", "ix_images_lib_recent", "ix_images_group_recent"),
        ("top", "L1", "ix_images_lib_top", "ix_images_group_top"),
        ("shuffle", None, "ix_images_shuffle", "ix_images_group_shuffle"),
        ("shuffle", "L1", "ix_images_lib_shuffle", "ix_images_group_shuffle"),
    ],
)
def test_page_walks_the_sort_index_and_probes_the_batch(sort, lib, walk, probe):
    """The page walks the feed's sort index (no sort of every match) and
    each row's "earlier member?" probe seeks the batch index."""
    f = FeedFilter(sort=sort, library_id=lib)
    keys = SORTS[sort][0]
    parts = image_feed._paged(
        sa.select(t.images.c._id).where(feed_where(f), image_feed._group_head(f)),
        f,
        cursor="|".join(["5.0"] * len(keys) + ["L1:x"]),
        limit=50,
        offset=0,
    )
    engine = sa.create_engine("sqlite://")
    for stmt in parts:
        sql = str(stmt.compile(engine, compile_kwargs={"literal_binds": True}))
        plan = _plan(sql)
        assert f"USING INDEX {walk} " in plan, plan
        assert f"USING INDEX {probe} (gen_group_id=? AND <expr>>?)" in plan or (
            f"USING INDEX {probe} (gen_group_id=? AND <expr><?)" in plan
        ), plan
        assert "TEMP B-TREE" not in plan, plan
