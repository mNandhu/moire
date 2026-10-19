"""Integration tests for tag rename / merge and the canonical (underscore) tag
spelling: manual renames rewrite once, prompt merges are rules that survive
reprojection, AI tags are refused."""

import pytest
import sqlalchemy as sa

from src.database import db
from src.database import schema as t
from src.services import reproject

pytestmark = pytest.mark.asyncio


async def _tags(image_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.images.c.tags).where(t.images.c._id == image_id)
            )
        ).scalar()


def _raw(image_id, prompt):
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=None,
                raw={"source": "a1111", "parameters": f"{prompt}\nSteps: 20"},
            )
        )


async def test_manual_add_stores_underscores_and_either_spelling_filters(client, seed):
    seed("L1:a", tags=())
    await client.post("/tags/apply/L1:a", json=["blue eyes"])
    assert await _tags("L1:a") == ["manual:blue_eyes"]
    for spelling in ("manual:blue eyes", "manual:blue_eyes", "any:blue eyes"):
        resp = await client.get("/images", params={"tags": spelling})
        assert [it["_id"] for it in resp.json()] == ["L1:a"], spelling


async def test_rename_manual_rewrites_and_merges(client, seed):
    seed("L1:a", tags=("1girl", "manual:keepr"))
    seed("L1:b", tags=("manual:keepr", "manual:keeper"))
    resp = await client.post(
        "/tags/rename", json={"tag": "manual:keepr", "to": "keeper"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "kind": "manual",
        "from": "manual:keepr",
        "to": "manual:keeper",
        "images": 2,
    }
    assert await _tags("L1:a") == ["1girl", "manual:keeper"]
    assert await _tags("L1:b") == ["manual:keeper"]
    counts = (await client.get("/tags", params={"include_manual": True})).json()
    assert {r["_id"]: r["count"] for r in counts} == {"1girl": 1, "manual:keeper": 2}


async def test_rename_moves_a_pinned_thumbnail(client, seed):
    seed("L1:a", tags=("manual:old",))
    await client.post("/tags/thumbnail/manual:old", json={"image_id": "L1:a"})
    await client.post("/tags/rename", json={"tag": "manual:old", "to": "new"})
    async with db.async_conn() as conn:
        pins = (await conn.execute(sa.select(t.tag_meta.c.tag))).scalars().all()
    assert pins == ["manual:new"]


async def test_ai_tags_cannot_be_renamed(client, seed):
    seed("L1:a", tags=("blonde_hair",))
    resp = await client.post("/tags/rename", json={"tag": "blonde_hair", "to": "x"})
    assert resp.status_code == 422


async def test_same_name_in_other_spelling_is_refused(client, seed):
    seed("L1:a", tags=("manual:blue_eyes",))
    resp = await client.post(
        "/tags/rename", json={"tag": "manual:blue_eyes", "to": "blue eyes"}
    )
    assert resp.status_code == 422


async def test_prompt_merge_is_a_rule_that_survives_reprojection(client, seed):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    _raw("L1:a", "blonde, smile")
    _raw("L1:b", "blonde hair, smile")
    reproject.reproject_library("L1")
    assert "prompt:blonde" in await _tags("L1:a")

    resp = await client.post(
        "/tags/rename", json={"tag": "prompt:blonde", "to": "blonde hair"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["to"] == "prompt:blonde_hair"
    assert "prompt:blonde_hair" in await _tags("L1:a")
    assert "prompt:blonde" not in await _tags("L1:a")

    # A full re-extraction (e.g. a ruleset edit) keeps the merge.
    reproject.reproject_library("L1")
    assert "prompt:blonde_hair" in await _tags("L1:a")
    # Prompt-term search follows the merge too.
    resp = await client.get("/images", params={"pterms": "blonde hair"})
    assert sorted(it["_id"] for it in resp.json()) == ["L1:a", "L1:b"]

    assert (await client.get("/tags/aliases")).json()[0]["from"] == "blonde"


async def test_deleting_a_rule_restores_the_original_names(client, seed):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    _raw("L1:a", "blonde")
    _raw("L1:b", "blonde hair")
    reproject.reproject_library("L1")
    await client.post(
        "/tags/rename", json={"tag": "prompt:blonde", "to": "blonde_hair"}
    )

    resp = await client.delete("/tags/aliases/blonde")
    assert resp.status_code == 200, resp.text
    assert await _tags("L1:a") == ["prompt:blonde"]
    assert await _tags("L1:b") == ["prompt:blonde_hair"]
    assert (await client.delete("/tags/aliases/blonde")).status_code == 404


async def test_rules_stay_one_hop_and_refuse_loops(client, seed):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    _raw("L1:a", "a1")
    _raw("L1:b", "b1")
    reproject.reproject_library("L1")
    await client.post("/tags/rename", json={"tag": "prompt:a1", "to": "b1"})
    # b1 -> c1 repoints a1 -> c1 rather than chaining a1 -> b1 -> c1.
    await client.post("/tags/rename", json={"tag": "prompt:b1", "to": "c1"})
    rules = {r["from"]: r["to"] for r in (await client.get("/tags/aliases")).json()}
    assert rules == {"a1": "c1", "b1": "c1"}
    assert await _tags("L1:a") == ["prompt:c1"]

    # c1 -> a1 would loop through the existing a1 -> c1 rule.
    resp = await client.post("/tags/rename", json={"tag": "prompt:c1", "to": "a1"})
    assert resp.status_code == 422
