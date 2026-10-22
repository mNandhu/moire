"""Integration tests for the tag cloud, cross-source merge, and tag mutations:
including the tag-state invariant (array + flags + derived join rows stay in sync).
"""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import attire, tag_index

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


async def test_bulk_manual_adds_and_removes_across_selection(client, seed):
    seed("L1:a", tags=("1girl", "manual:old"))
    seed("L1:b", tags=("manual:keeper",))
    seed("L1:c", tags=("1girl",))  # not selected
    resp = await client.post(
        "/tags/bulk",
        json={
            "image_ids": ["L1:a", "L1:b", "L1:missing"],
            "add": ["keeper"],
            "remove": ["old"],
        },
    )
    assert resp.status_code == 200, resp.text
    # b already had keeper and no old: matched but unchanged.
    assert resp.json() == {"matched": 2, "modified": 1}

    a = await _row("L1:a")
    assert a.tags == ["1girl", "manual:keeper"]
    assert a.has_ai_tags is True
    assert await _tag_rows("L1:a") == {"1girl", "manual:keeper"}
    assert (await _row("L1:c")).tags == ["1girl"]


async def test_bulk_manual_never_touches_ai_or_prompt_tags(client, seed):
    seed("L1:a", tags=("cat", "prompt:cat", "manual:cat"))
    resp = await client.post(
        "/tags/bulk", json={"image_ids": ["L1:a"], "remove": ["cat"]}
    )
    assert resp.status_code == 200, resp.text
    assert (await _row("L1:a")).tags == ["cat", "prompt:cat"]


async def test_bulk_manual_rejects_empty_edit(client, seed):
    seed("L1:a", tags=())
    resp = await client.post("/tags/bulk", json={"image_ids": ["L1:a"]})
    assert resp.status_code == 422


async def test_bulk_manual_invalidates_tag_counts(client, seed):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    assert (await client.get("/tags", params={"include_manual": True})).json() == []
    await client.post(
        "/tags/bulk", json={"image_ids": ["L1:a", "L1:b"], "add": ["fav"]}
    )
    resp = await client.get("/tags", params={"include_manual": True})
    assert {r["_id"]: r["count"] for r in resp.json()} == {"manual:fav": 2}


async def test_tag_facets_route(client):
    r = await client.get("/tags/facets")
    assert r.status_code == 200
    facets = r.json()
    assert facets["blue_eyes"] == "look"
    assert facets["serafuku"] == "outfit"
    assert set(facets.values()) <= {"look", "outfit", "pose", "scene", "framing"}


async def test_attire_and_facet_maps_know_the_library_garments(client, seed):
    seed("L1:a", tags=("prompt:pastel_pink_dolphin_shorts", "prompt:collarbone"))
    attire_map = (await client.get("/tags/attire")).json()
    assert attire_map["pastel_pink_dolphin_shorts"] == "attire"
    assert "collarbone" not in attire_map
    facets = (await client.get("/tags/facets")).json()
    assert facets["pastel_pink_dolphin_shorts"] == "outfit"
    # Kept until a tag write, then rebuilt with the new tags.
    seed("L1:b", tags=("prompt:blue_cotton_panties",))
    assert "blue_cotton_panties" not in (await client.get("/tags/attire")).json()
    tag_index.invalidate()
    assert (await client.get("/tags/attire")).json()[
        "blue_cotton_panties"
    ] == "sexual_attire"


async def test_descriptions_serve_the_shipped_file(client, tmp_path, monkeypatch):
    from moire.services import tag_descriptions

    path = tmp_path / "tag_descriptions.json"
    path.write_text(
        '{"about": "x", "descriptions": {"ahoge": "A stray lock of hair."}}'
    )
    monkeypatch.setattr(tag_descriptions, "PATH", path)
    tag_descriptions.reset_for_tests()
    try:
        resp = await client.get("/tags/descriptions")
        assert resp.json()["ahoge"] == "A stray lock of hair."
    finally:
        tag_descriptions.reset_for_tests()


async def test_descriptions_missing_file_is_empty(client, tmp_path, monkeypatch):
    from moire.services import tag_descriptions

    monkeypatch.setattr(tag_descriptions, "PATH", tmp_path / "absent.json")
    tag_descriptions.reset_for_tests()
    try:
        assert (await client.get("/tags/descriptions")).json() == {}
    finally:
        tag_descriptions.reset_for_tests()


async def test_descriptions_fold_in_aliases_of_described_tags():
    from moire.services import tag_descriptions

    got = tag_descriptions.with_aliases(
        {"closed_eyes": "Both eyes are shut.", "smile": "A smile."},
        {"eyes_closed": "closed_eyes", "grin_wide": "missing_tag", "smile": "other"},
    )
    assert got == {
        "closed_eyes": "Both eyes are shut.",
        "eyes_closed": "Both eyes are shut.",
        "smile": "A smile.",
    }


async def test_descriptions_never_start_the_tag_list_download(client, monkeypatch):
    from moire.services import danbooru_tags

    def boom():
        raise AssertionError("descriptions must not fetch Danbooru's list")

    monkeypatch.setattr(danbooru_tags, "ensure_fresh", boom)
    assert (await client.get("/tags/descriptions")).status_code == 200


async def test_descriptions_merge_is_kept_until_the_alias_map_changes(
    tmp_path, monkeypatch
):
    from moire.services import tag_descriptions

    path = tmp_path / "tag_descriptions.json"
    path.write_text('{"descriptions": {"closed_eyes": "Shut."}}')
    monkeypatch.setattr(tag_descriptions, "PATH", path)
    tag_descriptions.reset_for_tests()
    try:
        aliases = {"eyes_closed": "closed_eyes"}
        first = tag_descriptions.served(aliases)
        assert first == {"closed_eyes": "Shut.", "eyes_closed": "Shut."}
        assert tag_descriptions.served(aliases) is first
        assert tag_descriptions.served({}) == {"closed_eyes": "Shut."}
    finally:
        tag_descriptions.reset_for_tests()


async def test_tag_groups_route(client, seed):
    seed("L1:a", tags=("serafuku", "prompt:pastel_pink_dolphin_shorts", "manual:fav"))
    body = (await client.get("/tags/groups")).json()
    assert body["tags"]["serafuku"] == attire.group_of("serafuku")
    assert body["tags"]["pastel_pink_dolphin_shorts"] == "attire"
    assert "fav" not in body["tags"]
    assert body["categories"]["attire"] == "attire_and_body_accessories"
    assert set(body["categories"]) == set(body["tags"].values())
