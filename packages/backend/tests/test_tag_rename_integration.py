"""Integration tests for tag rename / merge and the canonical (underscore) tag
spelling: manual renames rewrite once, prompt merges are rules that survive
reprojection, AI tags are refused."""

import asyncio

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import reproject

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
    assert pins == ["new"]


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
    assert rules == {"a1": ["c1"], "b1": ["c1"]}
    assert await _tags("L1:a") == ["prompt:c1"]

    # c1 -> a1 would loop through the existing a1 -> c1 rule.
    resp = await client.post("/tags/rename", json={"tag": "prompt:c1", "to": "a1"})
    assert resp.status_code == 422


async def _rules(client):
    return {r["from"]: r["to"] for r in (await client.get("/tags/aliases")).json()}


async def test_split_rule_reads_one_prompt_name_as_several(client, seed):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    _raw("L1:a", "long white hair, smile")
    _raw("L1:b", "long hair, white hair")
    reproject.reproject_library("L1")
    resp = await client.post(
        "/tags/aliases",
        json={
            "rules": [{"from": "long white hair", "to": ["long hair", "white_hair"]}]
        },
    )
    assert resp.json() == {"rules": 1, "skipped": [], "images": 1, "background": False}
    assert await _tags("L1:a") == [
        "prompt:long_hair",
        "prompt:smile",
        "prompt:white_hair",
    ]
    reproject.reproject_library("L1")
    assert "prompt:long_white_hair" not in await _tags("L1:a")
    assert await _rules(client) == {"long_white_hair": ["long_hair", "white_hair"]}

    # Undo: only images carrying every target are re-derived; both get their
    # own prompt's names back.
    resp = await client.delete("/tags/aliases/long_white_hair")
    assert resp.json()["to"] == ["long_hair", "white_hair"]
    assert resp.json()["images"] == 2
    assert await _tags("L1:a") == ["prompt:long_white_hair", "prompt:smile"]
    assert await _tags("L1:b") == ["prompt:long_hair", "prompt:white_hair"]


async def test_split_targets_follow_a_later_merge(client, seed):
    seed("L1:a", tags=())
    _raw("L1:a", "x1, y1")
    reproject.reproject_library("L1")
    await client.post(
        "/tags/aliases", json={"rules": [{"from": "a1", "to": ["b1", "c1"]}]}
    )
    await client.post("/tags/aliases", json={"rules": [{"from": "b1", "to": ["d1"]}]})
    assert await _rules(client) == {"a1": ["d1", "c1"], "b1": ["d1"]}
    # Merging onto a split name stands for its split.
    resp = await client.post("/tags/rename", json={"tag": "prompt:x1", "to": "a1"})
    assert resp.json()["to_all"] == ["prompt:d1", "prompt:c1"]
    assert await _tags("L1:a") == ["prompt:c1", "prompt:d1", "prompt:y1"]


async def test_a_name_has_one_rule_and_loops_through_splits_are_refused(client, seed):
    seed("L1:a", tags=())
    await client.post(
        "/tags/aliases", json={"rules": [{"from": "a1", "to": ["b1", "c1"]}]}
    )
    await client.post("/tags/aliases", json={"rules": [{"from": "a1", "to": ["e1"]}]})
    assert await _rules(client) == {"a1": ["e1"]}
    await client.post(
        "/tags/aliases", json={"rules": [{"from": "a1", "to": ["b1", "c1"]}]}
    )
    resp = await client.post(
        "/tags/aliases",
        json={"rules": [{"from": "c1", "to": ["a1"]}, {"from": "f1", "to": ["g1"]}]},
    )
    assert resp.json() == {
        "rules": 1,
        "skipped": [
            {
                "from": "c1",
                "reason": "a1 is already merged into c1; remove that rule first",
            }
        ],
        "images": 0,
        "background": False,
    }
    assert await _rules(client) == {"a1": ["b1", "c1"], "f1": ["g1"]}


async def test_merge_suggestions_read_prompt_tags_against_danbooru(
    client, seed, tmp_path, monkeypatch
):
    from moire.services import danbooru_tags

    path = tmp_path / "danbooru-tags.csv"
    path.write_text(
        "long_hair,0,500,\nwhite_hair,0,500,\nheart_pasties,0,500,\n"
        'fellatio,0,500,"blowjob"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(danbooru_tags, "list_path", lambda: path)
    monkeypatch.setattr(danbooru_tags, "ensure_fresh", lambda: None)
    danbooru_tags.reset_for_tests()
    seed("L1:a", tags=())
    _raw("L1:a", "long white hair, black heart pasties, blowjob, long hair, sparkles")
    reproject.reproject_library("L1")
    await client.post(
        "/tags/aliases", json={"rules": [{"from": "blowjob", "to": ["fellatio"]}]}
    )

    body = (await client.get("/tags/merge-suggestions")).json()
    assert body["available"] is True
    assert {s["from"]: (s["to"], s["kind"]) for s in body["suggestions"]} == {
        "long_white_hair": (["long_hair", "white_hair"], "split"),
        "black_heart_pasties": (["heart_pasties"], "strip"),
    }
    danbooru_tags.reset_for_tests()


async def test_a_character_is_not_split_or_suggested(client, seed):
    async with db.async_tx() as conn:
        await conn.execute(sa.insert(t.characters).values(tag="red_hood"))
    resp = await client.post(
        "/tags/aliases",
        json={"rules": [{"from": "red_hood", "to": ["red_cape", "hood"]}]},
    )
    assert resp.json()["rules"] == 0
    assert "character" in resp.json()["skipped"][0]["reason"]
    # A plain merge still works.
    resp = await client.post(
        "/tags/aliases", json={"rules": [{"from": "red_hood", "to": ["hood"]}]}
    )
    assert resp.json()["rules"] == 1


async def test_replacing_a_rule_reprojects_the_images_it_had_merged(client, seed):
    seed("L1:a", tags=())
    _raw("L1:a", "a1")
    reproject.reproject_library("L1")
    await client.post("/tags/aliases", json={"rules": [{"from": "a1", "to": ["b1"]}]})
    assert await _tags("L1:a") == ["prompt:b1"]
    resp = await client.post(
        "/tags/aliases", json={"rules": [{"from": "a1", "to": ["c1", "d1"]}]}
    )
    assert resp.json()["images"] == 1
    assert await _tags("L1:a") == ["prompt:c1", "prompt:d1"]


async def test_suggestions_leave_out_names_a_rule_leads_to(
    client, seed, tmp_path, monkeypatch
):
    from moire.services import danbooru_tags

    path = tmp_path / "danbooru-tags.csv"
    path.write_text('grey_hair,0,500,"silver_hair"\n', encoding="utf-8")
    monkeypatch.setattr(danbooru_tags, "list_path", lambda: path)
    danbooru_tags.reset_for_tests()
    seed("L1:a", tags=())
    _raw("L1:a", "grey hair")
    reproject.reproject_library("L1")
    # The user prefers silver_hair: Danbooru's alias mustn't undo that.
    await client.post(
        "/tags/aliases", json={"rules": [{"from": "grey_hair", "to": ["silver_hair"]}]}
    )
    body = (await client.get("/tags/merge-suggestions")).json()
    assert body == {"available": True, "suggestions": []}
    danbooru_tags.reset_for_tests()


async def test_renaming_one_source_keeps_the_pin_of_a_base_still_in_use(client, seed):
    seed("L1:a", tags=("foo",))
    seed("L1:b", tags=("manual:foo",))
    await client.post("/tags/thumbnail/foo", json={"image_id": "L1:a"})
    async with db.async_tx() as conn:
        await conn.execute(sa.insert(t.characters).values(tag="foo"))
    resp = await client.post("/tags/rename", json={"tag": "manual:foo", "to": "bar"})
    assert resp.status_code == 200, resp.text
    async with db.async_conn() as conn:
        pins = (await conn.execute(sa.select(t.tag_meta.c.tag))).scalars().all()
        chars = (await conn.execute(sa.select(t.characters.c.tag))).scalars().all()
    # The AI tag `foo` still exists and keeps its page settings.
    assert pins == ["foo"]
    assert chars == ["foo"]


async def test_a_prompt_rule_keeps_the_pin_of_a_base_still_in_use(client, seed):
    seed("L1:a", tags=("foo", "prompt:foo"))
    await client.post("/tags/thumbnail/foo", json={"image_id": "L1:a"})
    resp = await client.post("/tags/rename", json={"tag": "prompt:foo", "to": "bar"})
    assert resp.status_code == 200, resp.text
    async with db.async_conn() as conn:
        pins = (await conn.execute(sa.select(t.tag_meta.c.tag))).scalars().all()
    assert pins == ["foo"]


async def test_every_rule_change_reprojects_big_sets_in_the_background(
    client, seed, monkeypatch
):
    """Rename, add and delete share one policy: up to the threshold inline
    (shown as activity), above it in the background, ``background`` saying
    which."""
    from moire.services import activity, tag_rename

    seed("L1:a", tags=())
    _raw("L1:a", "blonde")
    reproject.reproject_library("L1")

    tracked: list[str] = []
    track = activity.track

    def spy(kind, **kw):
        tracked.append(kind)
        return track(kind, **kw)

    monkeypatch.setattr(activity, "track", spy)
    resp = await client.post(
        "/tags/rename", json={"tag": "prompt:blonde", "to": "blonde_hair"}
    )
    assert resp.json()["background"] is False
    assert tracked == ["reproject"]
    assert await _tags("L1:a") == ["prompt:blonde_hair"]

    queued: list[list[str]] = []
    monkeypatch.setattr(tag_rename, "_SYNC_REPROJECT", 0)
    monkeypatch.setattr(reproject, "reproject_ids_async", queued.append)
    resp = await client.delete("/tags/aliases/blonde")
    assert resp.json()["background"] is True
    resp = await client.post(
        "/tags/rename", json={"tag": "prompt:blonde_hair", "to": "yellow"}
    )
    assert resp.json()["background"] is True
    assert queued == [["L1:a"], ["L1:a"]]


async def test_a_small_rule_change_does_not_wait_behind_a_running_reprojection(
    client, seed, monkeypatch
):
    seed("L1:a", tags=())
    _raw("L1:a", "blonde")
    reproject.reproject_library("L1")
    queued: list[list[str]] = []
    monkeypatch.setattr(reproject, "reproject_ids_async", queued.append)
    # A run that takes the lock after any "is it busy?" look must not make
    # the request wait either: the busy hint says no, the lock is held.
    monkeypatch.setattr(reproject, "busy", lambda: False)
    assert reproject._run_lock.acquire(timeout=5)
    try:
        resp = await asyncio.wait_for(
            client.post(
                "/tags/rename", json={"tag": "prompt:blonde", "to": "blonde_hair"}
            ),
            5,
        )
    finally:
        reproject._run_lock.release()
    assert resp.json()["background"] is True
    assert queued == [["L1:a"]]


async def test_an_inline_reprojection_failure_finishes_in_the_background(
    client, seed, monkeypatch
):
    """The rule is saved before the reprojection; if that fails inline the
    request still succeeds, the tag list is refreshed and the work retried
    in the background."""
    from moire.services import tag_index

    seed("L1:a", tags=())
    _raw("L1:a", "blonde")
    reproject.reproject_library("L1")

    def boom(ids):
        raise RuntimeError("disk on fire")

    queued: list[list[str]] = []
    invalidated: list[bool] = []
    monkeypatch.setattr(reproject, "try_reproject_ids_tracked", boom)
    monkeypatch.setattr(reproject, "reproject_ids_async", queued.append)
    monkeypatch.setattr(tag_index, "invalidate", lambda: invalidated.append(True))
    resp = await client.post(
        "/tags/rename", json={"tag": "prompt:blonde", "to": "blonde_hair"}
    )
    assert resp.status_code == 200
    assert resp.json()["background"] is True
    assert queued == [["L1:a"]]
    assert invalidated
    aliases = (await client.get("/tags/aliases")).json()
    assert [a["from"] for a in aliases] == ["blonde"]
