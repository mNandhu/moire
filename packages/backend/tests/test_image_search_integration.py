"""Ctrl/Cmd+K image search: by file name, inside the library, hidden images out."""

from __future__ import annotations

import pytest

from moire.services.images import search as image_search
from moire.services.tags import sensitivity as tag_sensitivity


@pytest.fixture(autouse=True)
def shipped_levels():
    tag_sensitivity.ship_for_tests({"level_three_tag": 3})


async def _search(client, q, **params):
    resp = await client.get("/images/search", params={"q": q, **params})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_finds_by_name_with_underscores_as_spaces(client, seed):
    seed("L1:out/ComfyUI_00123_.png", mtime=1)
    seed("L1:out/ComfyUI_00456_.png", mtime=2)
    seed("L1:other/portrait.png", mtime=3)

    rows = await _search(client, "comfyui 00123")
    assert [r["_id"] for r in rows] == ["L1:out/ComfyUI_00123_.png"]
    assert rows[0]["name"] == "ComfyUI_00123_.png"
    assert rows[0]["folder"] == "out"
    assert rows[0]["thumb_url"].startswith("/api/v1/images/")
    assert "thumb_key" not in rows[0]

    # A typed underscore reads as a space; a `%` is literal, not a LIKE wildcard.
    assert {r["_id"] for r in await _search(client, "ComfyUI_")} == {
        "L1:out/ComfyUI_00123_.png",
        "L1:out/ComfyUI_00456_.png",
    }
    assert await _search(client, "%") == []


async def test_name_hits_rank_before_folder_hits(client, seed):
    # Newest first would put the folder-only hit on top.
    seed("L1:sunset/a.png", mtime=3)
    seed("L1:misc/sunset_beach.png", mtime=2)
    seed("L1:misc/beach_sunset.png", mtime=1)

    rows = await _search(client, "sunset")
    assert [r["_id"] for r in rows] == [
        "L1:misc/sunset_beach.png",
        "L1:misc/beach_sunset.png",
        "L1:sunset/a.png",
    ]


async def test_library_id_does_not_match(client, seed):
    seed("library42:x.png", library_id="library42")
    assert await _search(client, "library42") == []


async def test_hidden_images_are_left_out(client, seed):
    seed("L1:keep_general.png", tags=("1girl",), rating="general")
    seed("L1:keep_explicit.png", tags=("1girl", "prompt:level_three_tag"))
    seed("L1:keep_quarantined.png", tags=("1girl",), rating="general", quarantined=True)
    resp = await client.post("/sensitivity", json={"max_level": "sensitive"})
    assert resp.status_code == 200, resp.text

    assert [r["_id"] for r in await _search(client, "keep")] == ["L1:keep_general.png"]


async def test_limit_and_blank_query(client, seed):
    for i in range(5):
        seed(f"L1:img_{i}.png", mtime=i)
    assert len(await _search(client, "img", limit=2)) == 2
    assert await _search(client, "   ") == []
    assert (await client.get("/images/search", params={"q": ""})).status_code == 422


def test_normalize():
    assert image_search.normalize("  A__B\\c  ") == "a b/c"
