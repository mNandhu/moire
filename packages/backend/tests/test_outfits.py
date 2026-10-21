"""Outfits: saved ones per character or shared, hidden per character, the
computed Default with its thumbnail, the save dialog's prefill, and an
outfit reaching ComfyUI right after its character (recorded as sent)."""

from __future__ import annotations

import asyncio

import pytest

from moire.services import outfits, tag_categories
from moire.services.outfits import OutfitError
from tests.test_characters import _chars
from tests.test_generate_integration import comfy, make_ready  # noqa: F401
from tests.test_recipes import _library

HU = "hu_tao_(genshin_impact)"


def test_clean_canonicalizes_and_limits():
    out = outfits.clean(
        {"name": " Funeral ", "tags": ["porkpie hat", "porkpie_hat", "long coat"]},
        new=True,
    )
    assert out == {"name": "Funeral", "tags": ["porkpie_hat", "long_coat"]}
    with pytest.raises(OutfitError):
        outfits.clean({"name": "x", "tags": []}, new=True)
    with pytest.raises(OutfitError):
        outfits.clean({"name": "", "tags": ["hat"]}, new=True)
    with pytest.raises(OutfitError):
        outfits.clean({"shared": "yes"}, new=False)
    assert outfits.clean({"image_id": ""}, new=False) == {"image_id": None}


def test_tag_info_marks_what_the_tagger_cant_check():
    info = outfits.tag_info(
        ["porkpie_hat", "plum_ornament"], frozenset({"porkpie_hat"})
    )
    assert [(i["tag"], i["checkable"]) for i in info] == [
        ("porkpie_hat", True),
        ("plum_ornament", False),
    ]
    # No vocabulary read yet: nothing is judged.
    assert outfits.tag_info(["x"], frozenset())[0]["checkable"] is True


def test_clean_tags_drops_source_prefixes_and_caps():
    assert outfits.clean_tags(["manual:hat", "prompt:red dress", "hat", " "]) == [
        "hat",
        "red_dress",
    ]
    assert len(outfits.clean_tags([f"t{i}" for i in range(60)])) == outfits.MAX_TAGS
    with pytest.raises(OutfitError):
        outfits.clean({"name": "x", "tags": [f"t{i}" for i in range(41)]}, new=True)


async def test_outfits_end_to_end(client, comfy, seed, monkeypatch):  # noqa: F811
    monkeypatch.setattr(tag_categories, "load", _chars(HU, hu_tao="genshin_impact"))
    await asyncio.to_thread(_library, seed)
    seed("L1:wear", tags=(HU, "porkpie_hat", "manual:long_coat", "prompt:sandals"))
    seed("L1:bare", tags=(HU, "porkpie_hat", "nude"), score=5)

    d = (await client.get("/generate/outfits/default", params={"character": HU})).json()
    assert [x["tag"] for x in d["tags"]] == ["porkpie_hat"]
    # The best-scored image wearing it (one of nobody dressed never is).
    assert d["image_id"] == "L1:h0"

    assert d["cover_picked"] is False
    # The cover picker's choices, most of the outfit first; a pick sticks.
    choices = (
        await client.get(
            "/generate/outfits/covers", params={"character": HU, "outfit": "default"}
        )
    ).json()
    assert choices[0] == {"image_id": "L1:h0", "matched": 1, "of": 1}
    assert "L1:bare" not in {c["image_id"] for c in choices}
    d = (
        await client.put(
            "/generate/outfits/default/cover",
            json={"character": HU, "image_id": "L1:h2"},
        )
    ).json()
    assert (d["image_id"], d["cover_picked"]) == ("L1:h2", True)
    d = (
        await client.put(
            "/generate/outfits/default/cover", json={"character": HU, "image_id": None}
        )
    ).json()
    assert (d["image_id"], d["cover_picked"]) == ("L1:h0", False)

    p = (
        await client.get(
            "/generate/outfits/prefill", params={"image": "L1:wear", "character": HU}
        )
    ).json()
    # Seen, added by hand or prompted; the usual ones it lacks would follow.
    assert [(x["tag"], x["source"]) for x in p["tags"]] == [
        ("porkpie_hat", "image"),
        ("long_coat", "image"),
        ("sandals", "image"),
    ]

    r = await client.post(
        "/generate/outfits",
        json={
            "name": "Funeral director",
            "character": HU,
            "tags": ["porkpie hat", "long coat"],
            "image_id": "L1:wear",
        },
    )
    assert r.status_code == 200, r.text
    own = r.json()
    assert own["character"] == HU and own["shared"] is False
    assert own["image_id"] == "L1:wear" and own["batches"] == 0
    shared = (
        await client.post(
            "/generate/outfits",
            json={
                "name": "Swimsuit",
                "character": HU,
                "tags": ["swimsuit"],
                "shared": True,
            },
        )
    ).json()
    bad = await client.post(
        "/generate/outfits", json={"name": "x", "character": "nobody", "tags": ["hat"]}
    )
    assert bad.status_code == 400

    listed = (await client.get("/generate/outfits", params={"character": HU})).json()
    assert {o["name"] for o in listed} == {"Funeral director", "Swimsuit"}
    # Only a shared one can be hidden.
    no = await client.put(
        f"/generate/outfits/{own['_id']}/hidden", json={"character": HU, "hidden": True}
    )
    assert no.status_code == 400
    ok = await client.put(
        f"/generate/outfits/{shared['_id']}/hidden",
        json={"character": HU, "hidden": True},
    )
    assert ok.status_code == 200
    listed = (await client.get("/generate/outfits", params={"character": HU})).json()
    assert {o["name"]: o["hidden"] for o in listed} == {
        "Funeral director": False,
        "Swimsuit": True,
    }
    # Unsharing drops the hides: shared again, it shows again.
    await client.put(f"/generate/outfits/{shared['_id']}", json={"shared": False})
    await client.put(f"/generate/outfits/{shared['_id']}", json={"shared": True})
    listed = (await client.get("/generate/outfits", params={"character": HU})).json()
    assert not next(o for o in listed if o["name"] == "Swimsuit")["hidden"]

    await make_ready(client, comfy, seed)
    body = {
        "positive": [
            {"kind": "character"},
            {"kind": "text", "role": "prompt", "text": "night"},
        ],
        "characters": [
            {
                "tag": HU,
                "label": "Hu Tao",
                "tags": [HU, "red_eyes"],
                "outfit": {
                    "id": own["_id"],
                    "name": "Funeral director",
                    "tags": ["porkpie_hat", "manual:long coat"],
                },
            }
        ],
        "count": 1,
    }
    res = await client.post("/generate/batches", json=body)
    assert res.status_code == 200, res.text
    batch = res.json()
    assert batch["name"] == "Hu Tao, Funeral director"
    graph = comfy.prompts[comfy.order[-1]]
    texts = [
        n["inputs"]["text"]
        for n in graph.values()
        if n["class_type"] == "CLIPTextEncode"
    ]
    assert (
        "hu_tao_\\(genshin_impact\\), red_eyes, porkpie_hat, long_coat, night" in texts
    )

    # Editing the outfit later never changes what the batch recorded.
    await client.put(f"/generate/outfits/{own['_id']}", json={"tags": ["hat"]})
    got = (await client.get(f"/generate/batches/{batch['_id']}")).json()
    worn = got["inputs"]["characters"][0]["outfit"]
    assert worn["tags"] == ["porkpie_hat", "long_coat"]
    listed = (await client.get("/generate/outfits")).json()
    mine = next(o for o in listed if o["_id"] == own["_id"])
    assert (mine["batches"], mine["used_by"]) == (1, 1)

    assert (await client.delete(f"/generate/outfits/{own['_id']}")).status_code == 200
    assert (await client.delete(f"/generate/outfits/{own['_id']}")).status_code == 404


def test_new_character_outfit_setting_takes_known_values():
    from moire.services.comfy_settings import clean_patch

    assert clean_patch({"new_character_outfit": "default"}, {}) == {
        "new_character_outfit": "default"
    }
    assert clean_patch({"new_character_outfit": "all"}, {}) == {}
