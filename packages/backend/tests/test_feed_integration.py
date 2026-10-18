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
    # _id desc, quarantined hidden by default.
    assert await _ids(client) == ["L1:b", "L1:a"]


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
    for i in ids:
        seed(i)
    expected = sorted(ids, reverse=True)  # _id desc

    seen = []
    cursor = None
    while True:
        params = {"limit": 10}
        if cursor:
            params["cursor"] = cursor
        page = await _ids(client, **params)
        if not page:
            break
        seen.extend(page)
        cursor = page[-1]
        if len(page) < 10:
            break

    assert seen == expected  # each row once, stable desc order across pages
