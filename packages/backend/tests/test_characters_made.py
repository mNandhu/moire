"""Characters made by hand: a page, a list entry and a recipe before any
image carries the tag; deletable only until one does."""

from __future__ import annotations

import asyncio

from src.services import tag_index

FERN = "fern_(sousou_no_frieren)"


async def test_made_character_lives_until_images_have_it(client, seed, monkeypatch):
    from src.services import tag_categories

    async def vocab():
        return tag_categories.vocab({FERN}, set())

    monkeypatch.setattr(tag_categories, "load", vocab)
    r = await client.post(
        "/tags/characters", json={"tag": "Fern (Sousou no Frieren)", "name": "Fern"}
    )
    assert r.status_code == 200 and r.json()["tag"] == FERN

    listed = {c["tag"]: c for c in (await client.get("/tags/characters")).json()}
    assert listed[FERN]["count"] == 0 and listed[FERN]["name"] == "Fern"

    page = (await client.get("/tags/character", params={"tag": FERN})).json()
    assert page["made"] is True and page["count"] == 0

    # Its recipe takes added identity tags and a LoRA like any other.
    r = await client.put(
        f"/generate/recipes/{FERN}",
        json={"added": ["purple hair"], "lora": "fern_illu.safetensors"},
    )
    assert r.status_code == 200
    rec = r.json()
    assert [c["tag"] for c in rec["identity"]] == ["purple_hair"]
    assert rec["lora"]["stem"] == "fern_illu"

    assert (await client.post("/tags/characters", json={"tag": " "})).status_code == 422

    # An image with the tag makes it an ordinary character: no deleting.
    await asyncio.to_thread(seed, "L1:f1", tags=(f"prompt:{FERN}",))
    tag_index.invalidate()
    assert (
        await client.delete("/tags/character", params={"tag": FERN})
    ).status_code == 409


async def test_made_character_can_be_deleted(client):
    await client.post("/tags/characters", json={"tag": "my_oc"})
    assert (
        await client.delete("/tags/character", params={"tag": "my_oc"})
    ).status_code == 200
    tags = [c["tag"] for c in (await client.get("/tags/characters")).json()]
    assert "my_oc" not in tags
    assert (
        await client.get("/tags/character", params={"tag": "my_oc"})
    ).status_code == 404
    assert (await client.get("/generate/recipes/my_oc")).status_code == 404


async def test_making_a_character_twice_or_by_its_full_name_is_refused(
    client, seed, monkeypatch
):
    from src.services import tag_categories

    async def vocab():
        return tag_categories.vocab({"furina_(genshin_impact)"}, set())

    monkeypatch.setattr(tag_categories, "load", vocab)
    # The library knows her only by the bare name, backed by her series.
    for i in range(3):
        await asyncio.to_thread(
            seed, f"L1:u{i}", tags=("prompt:furina", "prompt:genshin_impact")
        )
    tag_index.invalidate()
    taken = await client.post(
        "/tags/characters", json={"tag": "furina_(genshin_impact)"}
    )
    assert taken.status_code == 409

    made = await client.post("/tags/characters", json={"tag": "My_OC"})
    assert made.json()["tag"] == "my_oc"
    again = await client.post("/tags/characters", json={"tag": "my oc"})
    assert again.status_code == 409
