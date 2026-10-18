"""Integration tests for the tag cloud, cross-source merge, and tag mutations:
including the tag-state invariant (array + flags + derived join rows stay in sync).
"""

import pytest
import sqlalchemy as sa

from src.database import db
from src.database import schema as t

pytestmark = pytest.mark.asyncio


async def _row(image_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
        ).first()


async def _tag_rows(image_id):
    async with db.async_conn() as conn:
        return {
            r.tag
            for r in (
                await conn.execute(
                    sa.select(t.image_tags.c.tag).where(
                        t.image_tags.c.image_id == image_id
                    )
                )
            ).fetchall()
        }


async def test_tag_cloud_default_is_ai_only(client, seed):
    seed("L1:a", tags=("cat", "manual:fav", "prompt:masterpiece"))
    seed("L1:b", tags=("cat",))
    resp = await client.get("/tags")
    by_tag = {r["_id"]: r["count"] for r in resp.json()}
    assert by_tag == {"cat": 2}  # manual:/prompt: excluded by default


async def test_tag_cloud_opts_into_manual_and_prompt(client, seed):
    seed("L1:a", tags=("cat", "manual:fav", "prompt:m"))
    resp = await client.get(
        "/tags", params={"include_manual": True, "include_prompt": True}
    )
    by_tag = {r["_id"]: r["count"] for r in resp.json()}
    assert by_tag == {"cat": 1, "manual:fav": 1, "prompt:m": 1}


async def test_merge_sources_counts_distinct_images_once(client, seed):
    # An image carrying both manual:cat and prompt:cat must count once for "cat".
    seed("L1:a", tags=("manual:cat", "prompt:cat"))
    seed("L1:b", tags=("cat",))
    resp = await client.get("/tags", params={"merge_sources": True})
    by_tag = {r["_id"]: r["count"] for r in resp.json()}
    assert by_tag == {"any:cat": 2}


async def test_apply_manual_tags_updates_array_flags_and_join_rows(client, seed):
    seed("L1:a", tags=())
    resp = await client.post("/tags/apply/L1:a", json=["fav"])
    assert resp.status_code == 200, resp.text

    row = await _row("L1:a")
    assert row.tags == ["manual:fav"]
    assert row.has_tags is True  # manual is curatable
    assert row.has_ai_tags is False
    assert await _tag_rows("L1:a") == {"manual:fav"}


async def test_remove_tags_resyncs_state(client, seed):
    seed("L1:a", tags=("1girl", "manual:fav"))
    resp = await client.post("/tags/remove/L1:a", json=["1girl"])
    assert resp.status_code == 200, resp.text

    row = await _row("L1:a")
    assert row.tags == ["manual:fav"]
    assert row.has_ai_tags is False
    assert await _tag_rows("L1:a") == {"manual:fav"}


async def test_clear_ai_tags_keeps_manual_and_prompt(client, seed):
    seed("L1:a", tags=("1girl", "solo", "manual:fav", "prompt:m"), rating="general")
    resp = await client.post("/ai/clear-ai-tags")
    assert resp.status_code == 200, resp.text
    assert resp.json()["modified"] == 1

    row = await _row("L1:a")
    assert set(row.tags) == {"manual:fav", "prompt:m"}
    assert row.has_ai_tags is False
    assert row.rating == "-"
    assert await _tag_rows("L1:a") == {"manual:fav", "prompt:m"}


async def test_tag_filter_reflects_mutation_end_to_end(client, seed):
    seed("L1:a", tags=())
    await client.post("/tags/apply/L1:a", json=["fav"])
    # The manual tag is now queryable via the any: fan-out.
    resp = await client.get("/images", params={"tags": "any:fav"})
    assert [it["_id"] for it in resp.json()] == ["L1:a"]
