"""Integration tests for the gallery feed: every filter axis + cursor pagination,
exercised through the real ASGI app against a temp SQLite DB."""

import pytest

pytestmark = pytest.mark.asyncio


async def _ids(client, **params):
    resp = await client.get("/images", params=params)
    assert resp.status_code == 200, resp.text
    return [it["_id"] for it in resp.json()]


async def test_default_feed_returns_all_non_quarantined_desc(client, seed):
    seed("L1:a")
    seed("L1:b")
    seed("L1:c", quarantined=True)
    # _id desc among equal (missing) mtimes, quarantined hidden by default.
    assert await _ids(client) == ["L1:b", "L1:a"]


async def test_feed_is_newest_first_across_libraries(client, seed):
    seed("L1:old", library_id="L1", mtime=100)
    seed("L2:new", library_id="L2", mtime=300)
    seed("L1:mid", library_id="L1", mtime=200)
    seed("L2:none", library_id="L2")  # no mtime: sorts last
    assert await _ids(client) == ["L2:new", "L1:mid", "L1:old", "L2:none"]
    assert await _ids(client, library_id="L1") == ["L1:mid", "L1:old"]


@pytest.mark.parametrize("cursor", ["L1:a", "nan|L1:a", "inf|L1:a", "1.0|"])
async def test_malformed_cursor_is_rejected(client, seed, cursor):
    resp = await client.get("/images", params={"cursor": cursor})
    assert resp.status_code == 422


async def test_cursor_comes_from_server_values_not_client_edits(client, seed):
    # Under "top", a client that rescored its last tile locally must not move
    # the page boundary: the server's cursor carries the score it sorted on.
    seed("L1:a", mtime=100, score=0)
    seed("L1:b", mtime=200, score=0)
    resp = await client.get("/images", params={"limit": 1, "sort": "top"})
    assert [it["_id"] for it in resp.json()] == ["L1:b"]
    assert resp.headers["X-Next-Cursor"] == "0.0|200.0|L1:b"
    nxt = await _ids(client, limit=1, sort="top", cursor=resp.headers["X-Next-Cursor"])
    assert nxt == ["L1:a"]


async def test_feed_items_do_not_carry_sort_columns(client, seed):
    seed("L1:a", mtime=1)
    (item,) = (await client.get("/images")).json()
    assert not any(k.startswith("sort_") for k in item)


async def test_quarantined_filter_shows_only_quarantined(client, seed):
    seed("L1:a")
    seed("L1:b", quarantined=True)
    assert await _ids(client, quarantined=1) == ["L1:b"]


async def test_tag_filter_exact(client, seed):
    seed("L1:a", tags=("cat", "dog"))
    seed("L1:b", tags=("dog",))
    assert await _ids(client, tags="cat") == ["L1:a"]


async def test_tag_and_logic_requires_all(client, seed):
    seed("L1:a", tags=("cat", "dog"))
    seed("L1:b", tags=("cat",))
    assert await _ids(client, tags=["cat", "dog"], logic="and") == ["L1:a"]


async def test_tag_or_logic_unions(client, seed):
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("dog",))
    seed("L1:c", tags=("bird",))
    got = await _ids(client, tags=["cat", "dog"], logic="or")
    assert set(got) == {"L1:a", "L1:b"}


async def test_any_prefix_fans_out_across_sources(client, seed):
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("manual:cat",))
    seed("L1:c", tags=("prompt:cat",))
    seed("L1:d", tags=("dog",))
    got = await _ids(client, tags="any:cat")
    assert set(got) == {"L1:a", "L1:b", "L1:c"}


async def test_no_ai_tags_filter(client, seed):
    seed("L1:a", tags=("1girl",))  # AI tag
    seed("L1:b", tags=("manual:fav",))  # manual only -> no AI tags
    assert await _ids(client, no_ai_tags=1) == ["L1:b"]


async def test_no_tags_filter(client, seed):
    seed("L1:a", tags=("1girl",))
    seed("L1:b", tags=())  # untagged
    seed("L1:c", tags=("prompt:x",))  # prompt-only stays "untagged" for curation
    assert set(await _ids(client, no_tags=1)) == {"L1:b", "L1:c"}


async def test_dimension_ranges(client, seed):
    seed("L1:small", width=100, height=100)
    seed("L1:big", width=2000, height=2000)
    assert await _ids(client, min_w=500) == ["L1:big"]
    assert await _ids(client, max_w=500) == ["L1:small"]


async def test_model_filter(client, seed):
    seed("L1:a", gen={"model": "sdxl", "workflow_sig": "s"})
    seed("L1:b", gen={"model": "pony", "workflow_sig": "s"})
    assert await _ids(client, model="sdxl") == ["L1:a"]


async def test_pterms_all_vs_in(client, seed):
    seed("L1:a", gen={"prompt_terms": ["masterpiece", "1girl"]})
    seed("L1:b", gen={"prompt_terms": ["masterpiece"]})
    # $all (and): must carry every term.
    assert await _ids(client, pterms=["masterpiece", "1girl"], plogic="and") == ["L1:a"]
    # $in (or): any term.
    assert set(await _ids(client, pterms=["masterpiece", "1girl"], plogic="or")) == {
        "L1:a",
        "L1:b",
    }


async def test_library_filter(client, seed):
    seed("L1:a", library_id="L1")
    seed("L2:a", library_id="L2")
    assert await _ids(client, library_id="L2") == ["L2:a"]


async def test_cursor_pagination_walks_every_row_once_in_order(client, seed):
    ids = [f"L1:{i:03d}" for i in range(25)]
    # Ties on mtime (pairs share one) must still page by _id without gaps.
    mtimes = {i: 1000.5 + n // 2 for n, i in enumerate(ids)}
    for i in ids:
        seed(i, mtime=mtimes[i])
    expected = sorted(ids, key=lambda i: (mtimes[i], i), reverse=True)

    seen = []
    cursor = None
    while True:
        params = {"limit": 10}
        if cursor:
            params["cursor"] = cursor
        resp = await client.get("/images", params=params)
        page = resp.json()
        if not page:
            break
        seen.extend(it["_id"] for it in page)
        cursor = resp.headers["X-Next-Cursor"]
        if len(page) < 10:
            break

    assert seen == expected  # each row once, stable desc order across pages


async def test_workflow_filters_by_family_and_version(client, seed):
    import sqlalchemy as sa

    from src.database import db
    from src.database import schema as t

    # Family W has two versions (s1, s2); s3 belongs to another family.
    seed("L1:a", gen={"workflow_sig": "s1"})
    seed("L1:b", gen={"workflow_sig": "s1"})
    seed("L1:c", gen={"workflow_sig": "s2"})
    seed("L1:d", gen={"workflow_sig": "s3"})
    seed("L1:e")
    with db.sync_tx() as conn:
        for image_id, sig, wid in [
            ("L1:b", "s1", "W"),  # s1's sample (newest id)
            ("L1:c", "s2", "W"),
            ("L1:d", "s3", "X"),
        ]:
            conn.execute(
                sa.insert(t.image_gen_raw).values(
                    _id=image_id,
                    library_id="L1",
                    workflow_sig=sig,
                    raw={"workflow": {"id": wid, "nodes": []}},
                )
            )

    assert await _ids(client, workflow="W") == ["L1:c", "L1:b", "L1:a"]
    assert await _ids(client, workflow="X") == ["L1:d"]
    assert await _ids(client, workflow="nope") == []
    assert await _ids(client, workflow_sig="s1") == ["L1:b", "L1:a"]
    groups = (await client.get("/images/groups", params={"workflow": "W"})).json()
    assert {g["_id"] for g in groups} == {"L1:a", "L1:b", "L1:c"}
    # "Select all" answers with the same images, the family expanded too
    got = (await client.get("/images/ids", params={"workflow": "W"})).json()
    assert got == {"ids": ["L1:c", "L1:b", "L1:a"], "truncated": False}


async def test_select_all_follows_the_feed_filter(client, seed, monkeypatch):
    from src.api import images

    seed("L1:a", tags=("cat",), gen={"group_id": "g1"})
    seed("L1:b", tags=("cat",), gen={"group_id": "g1"})
    seed("L1:c", tags=("cat",), quarantined=True)
    seed("L1:d", tags=("dog",))

    async def ids(**params):
        return (await client.get("/images/ids", params=params)).json()

    # batches don't matter: images, not batch representatives
    assert sorted((await ids(tags="cat"))["ids"]) == ["L1:a", "L1:b"]
    assert (await ids(tags="cat", quarantined=1))["ids"] == ["L1:c"]
    assert (
        await client.get("/images/ids", params={"logic": "bogus"})
    ).status_code == 422
    monkeypatch.setattr(images, "SELECT_ALL_CAP", 1)
    capped = await ids(tags="cat")
    assert len(capped["ids"]) == 1 and capped["truncated"] is True


@pytest.mark.parametrize(
    "sort,expected",
    [
        ("newest", ["L1:c", "L1:b", "L1:a", "L1:d"]),
        ("oldest", ["L1:d", "L1:a", "L1:b", "L1:c"]),
        # Best score first; equal scores newest first; unscored last.
        ("top", ["L1:a", "L1:c", "L1:b", "L1:d"]),
    ],
)
async def test_sorts_page_without_gaps(client, seed, sort, expected):
    seed("L1:a", mtime=100, score=5)
    seed("L1:b", mtime=200, score=3)
    seed("L1:c", mtime=300, score=3)
    seed("L1:d")  # no mtime, no score

    seen, cursor = [], None
    while True:
        params = {"limit": 1, "sort": sort}
        if cursor:
            params["cursor"] = cursor
        resp = await client.get("/images", params=params)
        page = resp.json()
        if not page:
            assert "X-Next-Cursor" not in resp.headers
            break
        seen.extend(it["_id"] for it in page)
        cursor = resp.headers["X-Next-Cursor"]
    assert seen == expected

    groups = (await client.get("/images/groups", params={"sort": sort})).json()
    assert [g["_id"] for g in groups] == expected


async def test_unknown_sort_is_rejected(client):
    assert (await client.get("/images", params={"sort": "random"})).status_code == 422
