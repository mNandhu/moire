"""The Global Sensitivity Filter: each image's level, what the feed, the
tag lists and the by-id routes show while it is on, and its setting."""

from __future__ import annotations

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.images import visibility as image_visibility
from moire.services.tags import sensitivity_filter

from moire.services.tags import sensitivity as tag_sensitivity

# Stand-ins for the shipped list.
ONE, TWO, THREE = "level_one_tag", "level_two_tag", "level_three_tag"


@pytest.fixture(autouse=True)
def shipped_levels():
    tag_sensitivity.ship_for_tests({ONE: 1, TWO: 2, THREE: 3})


def _level(image_id: str):
    with db.sync_conn() as conn:
        return conn.execute(
            sa.select(image_visibility.image_level()).where(t.images.c._id == image_id)
        ).scalar()


@pytest.mark.parametrize(
    "tags,rating,manual,want",
    [
        # Nothing to go on.
        ((), None, False, None),
        # A prompt that names nothing listed vouches for nothing.
        (("prompt:masterpiece", "prompt:score_9"), None, False, None),
        # A listed prompt word does raise it.
        (("prompt:masterpiece", f"prompt:{TWO}"), None, False, 2),
        # AI or manual tags vouch for general.
        (("1girl",), None, False, 0),
        (("manual:favourite",), None, False, 0),
        # The higher of the AI rating and the tags.
        (("1girl", f"prompt:{ONE}"), "questionable", False, 2),
        (("1girl", f"prompt:{THREE}"), "sensitive", False, 3),
        # A rating alone.
        ((), "sensitive", False, 1),
        # A hand-picked rating settles it, lower or higher.
        (("1girl", f"prompt:{THREE}"), "general", True, 0),
        (("1girl",), "explicit", True, 3),
    ],
)
def test_image_level(seed, tags, rating, manual, want):
    seed("L1:a", tags=tags, rating=rating, rating_manual=manual)
    assert _level("L1:a") == want


def _library(seed):
    seed("L1:general", tags=("1girl",), rating="general")
    seed("L1:sensitive", tags=("1girl", ONE))
    seed("L1:explicit", tags=("1girl", f"prompt:{THREE}"))
    seed("L1:unknown", tags=("prompt:masterpiece",))
    seed("L1:empty")


async def _feed(client):
    resp = await client.get("/images")
    assert resp.status_code == 200, resp.text
    return {row["_id"] for row in resp.json()}


async def _set(client, level):
    resp = await client.post("/sensitivity", json={"max_level": level})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_feed_shows_what_the_filter_allows(client, seed):
    _library(seed)
    everything = {"L1:general", "L1:sensitive", "L1:explicit", "L1:unknown", "L1:empty"}
    assert await _feed(client) == everything

    await _set(client, "general")
    assert await _feed(client) == {"L1:general"}
    await _set(client, "sensitive")
    assert await _feed(client) == {"L1:general", "L1:sensitive"}
    await _set(client, None)
    assert await _feed(client) == everything


async def test_by_id_routes_hide_what_the_filter_hides(client, seed):
    _library(seed)
    seed("L1:quarantined", tags=("1girl",), quarantined=True)
    await _set(client, "sensitive")
    assert (await client.get("/images/L1:explicit")).status_code == 403
    assert (await client.get("/images/L1:unknown")).status_code == 403
    assert (await client.get("/images/L1:explicit/thumb")).status_code == 404
    assert (await client.head("/images/L1:explicit/file")).status_code == 404
    assert (await client.get("/images/L1:explicit/workflow")).status_code == 404
    assert (await client.get("/images/L1:sensitive")).status_code == 200
    # Quarantine is no bar on a direct read: its own view opens them.
    assert (await client.get("/images/L1:quarantined")).status_code == 200


async def test_tag_lists_hide_tags_and_count_only_shown_images(client, seed):
    _library(seed)
    await _set(client, "sensitive")

    tags = await client.get("/tags", params={"merge_sources": True})
    counts = {row["_id"]: row["count"] for row in tags.json()}
    assert counts["any:1girl"] == 2  # the explicit image's copy doesn't count
    assert f"any:{THREE}" not in counts
    assert "any:masterpiece" not in counts  # its one image is hidden as unknown
    assert counts[f"any:{ONE}"] == 1

    browse = {row["tag"] for row in (await client.get("/tags/browse")).json()}
    assert THREE not in browse and ONE in browse

    assert (await client.get("/tags/detail", params={"tag": THREE})).status_code == 404
    descriptions = (await client.get("/tags/descriptions")).json()
    assert THREE not in descriptions and "1girl" in descriptions

    await _set(client, "general")
    browse = {row["tag"] for row in (await client.get("/tags/browse")).json()}
    assert ONE not in browse and "1girl" in browse


async def test_ai_coverage_still_counts_hidden_images(client, seed):
    """AI tagging is how an unknown image gets a level: it must stay queued."""
    _library(seed)
    await _set(client, "general")
    data = (await client.get("/ai/coverage")).json()
    assert data["total"] == 5
    assert data["no_tags"] == 2  # prompt-only counts as untagged too


async def test_setting_and_counts(client, seed):
    _library(seed)
    got = (await client.get("/sensitivity")).json()
    assert got["max_level"] is None
    assert got["counts"] == {
        "unknown": 2,
        "by_level": {"general": 1, "sensitive": 1, "questionable": 0, "explicit": 1},
    }
    assert (await _set(client, "questionable"))["max_level"] == "questionable"
    assert sensitivity_filter.max_level() == 2
    # Allowing explicit is allowing everything: off.
    assert (await _set(client, "explicit"))["max_level"] is None
    resp = await client.post("/sensitivity", json={"max_level": "spicy"})
    assert resp.status_code == 422


async def test_setting_survives_a_restart(client):
    await _set(client, "sensitive")
    sensitivity_filter.reset_for_tests()
    sensitivity_filter.load_sync()
    assert sensitivity_filter.max_level() == 1


async def test_changing_the_setting_drops_cached_tag_lists(client, seed):
    _library(seed)
    first = await client.get("/tags", params={"merge_sources": True})
    assert f"any:{THREE}" in {row["_id"] for row in first.json()}
    await _set(client, "general")
    again = await client.get("/tags", params={"merge_sources": True})
    assert f"any:{THREE}" not in {row["_id"] for row in again.json()}


async def test_a_hidden_image_reads_as_hidden_not_missing(client, seed):
    _library(seed)
    await _set(client, "general")
    resp = await client.get("/images/L1:explicit")
    assert resp.status_code == 403
    assert (await client.get("/images/L1:nothing")).status_code == 404


async def test_tag_levels_list_and_set(client, seed):
    seed("L1:a", tags=("prompt:my_word", "prompt:other_word"))
    seed("L1:b", tags=("prompt:my_word",))
    resp = await client.post(
        "/sensitivity/tags", json={"tag": "my_word", "level": "explicit"}
    )
    assert resp.status_code == 200 and resp.json()["changed"] == 2
    await client.post(
        "/sensitivity/tags", json={"tag": "other_word", "level": "sensitive"}
    )
    got = (await client.get("/sensitivity/tags")).json()
    assert got == {
        "tags": [
            {"tag": "my_word", "level": "explicit", "source": "user", "images": 2},
            {"tag": "other_word", "level": "sensitive", "source": "user", "images": 1},
        ],
        "hidden": 0,
    }
    # While the filter is on, the names it hides are only counted.
    await _set(client, "sensitive")
    got = (await client.get("/sensitivity/tags")).json()
    assert [r["tag"] for r in got["tags"]] == ["other_word"] and got["hidden"] == 1

    await client.post("/sensitivity/tags", json={"tag": "other_word", "level": None})
    assert (await client.get("/sensitivity/tags")).json()["tags"] == []
    bad = await client.post("/sensitivity/tags", json={"tag": "x", "level": "spicy"})
    assert bad.status_code == 422


# --- review fixes ---------------------------------------------------------------


async def test_picking_a_rating_refreshes_the_filtered_counts(client, seed):
    seed("L1:a", tags=("1girl",))
    await _set(client, "general")
    first = (await client.get("/tags", params={"merge_sources": True})).json()
    assert {r["_id"] for r in first} == {"any:1girl"}
    await client.post("/images/L1:a/rating", json={"rating": "explicit"})
    again = (await client.get("/tags", params={"merge_sources": True})).json()
    assert again == []
    counts = (await client.get("/sensitivity")).json()["counts"]
    assert counts["by_level"]["explicit"] == 1


async def test_remix_of_a_hidden_image_is_not_found(client, seed):
    _library(seed)
    await _set(client, "general")
    resp = await client.get("/generate/remix/L1:explicit", params={"full": True})
    assert resp.status_code == 404


async def test_search_style_names_are_filtered_too(client, seed):
    _library(seed)
    await _set(client, "general")
    got = (
        await client.get(
            "/tags/samples", params={"tags": [f"any:{THREE}", "any:1girl"]}
        )
    ).json()
    assert f"any:{THREE}" not in got and "any:1girl" in got


async def test_making_a_character_ignores_the_filter(client, seed):
    await _set(client, "general")
    resp = await client.post("/tags/characters", json={"tag": THREE})
    assert resp.status_code == 200, resp.text


def test_a_broken_shipped_list_reads_as_all_general(tmp_path, monkeypatch):
    bad = tmp_path / "levels.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(tag_sensitivity, "PATH", bad)
    tag_sensitivity.reset_for_tests()
    assert tag_sensitivity.level_of("anything") == 0
    assert tag_sensitivity.tag_level(["a", "b"]) == 0


async def test_by_id_reads_are_filtered_unless_asked(client, seed):
    from moire.services.tags import image_tags

    _library(seed)
    await _set(client, "general")
    assert await image_tags.find_image("L1:explicit", ("path",)) is None
    assert await image_tags.find_image("L1:explicit", ("path",), within_filter=False)


async def test_a_batch_cover_skips_hidden_outputs(client, seed):
    from moire.database.db import async_tx

    _library(seed)
    async with async_tx() as conn:
        await conn.execute(
            sa.insert(t.generation_batches).values(
                _id=1,
                generator_id="builtin",
                name="b",
                inputs={},
                state="done",
                created_at=0,
            )
        )
        await conn.execute(
            sa.insert(t.generation_requests).values(
                _id=1, batch_id=1, idx=0, state="done"
            )
        )
        for idx, image_id in enumerate(("L1:explicit", "L1:general")):
            await conn.execute(
                sa.insert(t.generation_outputs).values(
                    request_id=1,
                    idx=idx,
                    filename=f"{idx}.png",
                    subfolder="",
                    image_id=image_id,
                )
            )
    await _set(client, "general")
    batches = (await client.get("/generate/batches")).json()
    assert len(batches) == 1 and len(batches[0]["thumbs"]) == 1
    assert None not in batches[0]["thumbs"]
