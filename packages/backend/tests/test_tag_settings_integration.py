"""Boilerplate tag list: defaults until saved, cleaned on save."""

import pytest

from src.services.tag_settings import DEFAULT_BOILERPLATE, clean_boilerplate

pytestmark = pytest.mark.asyncio


async def test_defaults_until_saved_then_the_saved_list(client):
    body = (await client.get("/tags/settings")).json()
    assert body["boilerplate"] == list(DEFAULT_BOILERPLATE)
    assert body["default_boilerplate"] == list(DEFAULT_BOILERPLATE)

    saved = (
        await client.post(
            "/tags/settings", json={"boilerplate": ["Masterpiece", "score_*"]}
        )
    ).json()
    assert saved["boilerplate"] == ["masterpiece", "score_*"]
    assert (await client.get("/tags/settings")).json()["boilerplate"] == [
        "masterpiece",
        "score_*",
    ]


async def test_an_empty_list_is_a_real_choice(client):
    await client.post("/tags/settings", json={"boilerplate": []})
    assert (await client.get("/tags/settings")).json()["boilerplate"] == []


async def test_rejects_non_lists(client):
    resp = await client.post("/tags/settings", json={"boilerplate": "masterpiece"})
    assert resp.status_code == 422


def test_clean_trims_dedupes_and_refuses_match_everything():
    assert clean_boilerplate(
        ["  Best  Quality ", "best_quality", "", "*", " * ", "x" * 101, "absurdres"]
    ) == ["best quality", "absurdres"]


def test_clean_caps_the_list():
    assert len(clean_boilerplate([f"t{i}" for i in range(400)])) == 300
