"""Character recipes: identity tags without attire, the character's own LoRA
(not one used on everything), edits on top, and the Character block reaching
ComfyUI as an installed file."""

from __future__ import annotations

import asyncio
import dataclasses

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import characters, image_tags, recipes, tag_categories
from moire.services.generator_graph import merge_loras
from moire.services.recipes import LoraUse
from tests.test_characters import _chars
from tests.test_generate_integration import comfy, make_ready  # noqa: F401


def _use(stem, images, total, confirmed=0.0, prompted=0.0, strength=None):
    return LoraUse(stem, images, total, confirmed, prompted, strength)


def test_a_lora_used_on_everything_is_not_the_characters():
    detail = _use("add_detail", images=40, total=900, confirmed=60, prompted=60)
    own = _use("hu_tao_v2", images=12, total=14, confirmed=20, prompted=20)
    assert [u.stem for u in recipes.lora_candidates([detail, own])] == ["hu_tao_v2"]


def test_confirmed_images_rank_before_prompted_ones():
    a = _use("a", images=10, total=10, confirmed=0, prompted=30)
    b = _use("b", images=4, total=4, confirmed=5, prompted=5)
    c = _use("c", images=20, total=20)
    assert [u.stem for u in recipes.lora_candidates([a, b, c])] == ["b", "a", "c"]


def test_identity_is_capped_after_filtering():
    sig = [f"scene_{i}" for i in range(40)] + ["brown_hair", "red_eyes"]
    identity, _ = recipes.split_signature(sig)
    assert identity == ["brown_hair", "red_eyes"]


def test_a_lora_named_for_the_character_comes_first():
    names = ["nahida_(genshin_impact)"]
    style = _use("princess_xl_v2", images=325, total=330, confirmed=50)
    named = _use("NahidaXL", images=115, total=115, confirmed=5)
    once = _use("pixel_art", images=1, total=1, confirmed=9)
    got = recipes.lora_candidates([style, named, once], names)
    assert [u.stem for u in got] == ["NahidaXL", "princess_xl_v2"]
    assert recipes.name_words(["hu_tao_(genshin_impact)", "hu"]) == ["hutao"]


def test_a_character_on_most_images_doesnt_own_every_lora():
    style = _use("princess_xl_v2", images=70, total=100, confirmed=50)
    assert recipes.lora_candidates([style], [], share=0.6) == []
    assert recipes.lora_candidates([style], [], share=0.2) == [style]


def test_identity_is_body_features_and_attire_the_outfit():
    sig = [
        "red_eyes",
        "porkpie_hat",
        "twintails",
        "smile",
        "indoors",
        "looking_at_viewer",
        "nipples",
        "large_breasts",
        "flower-shaped_pupils",
    ]
    identity, outfit = recipes.split_signature(sig)
    assert identity == [
        "red_eyes",
        "twintails",
        "large_breasts",
        "flower-shaped_pupils",
    ]
    assert outfit == ["porkpie_hat"]


def test_edits_win_over_the_computed_recipe():
    cands = [_use("hu_tao_v2", 5, 5, 5, 5, strength=0.75), _use("alt", 2, 2)]
    chips, stem, strength, forced = recipes.apply_edits(
        ["red_eyes", "smile"], cands, None
    )
    assert chips == [
        {"tag": "red_eyes", "dropped": False, "added": False},
        {"tag": "smile", "dropped": False, "added": False},
    ]
    assert (stem, strength, forced) == ("hu_tao_v2", 0.75, False)

    edit = {"dropped": ["smile"], "lora": "alt", "strength": None}
    chips, stem, strength, forced = recipes.apply_edits(
        ["red_eyes", "smile"], cands, edit
    )
    assert chips[1] == {"tag": "smile", "dropped": True, "added": False}
    chips, *_ = recipes.apply_edits(["red_eyes"], cands, None, ["fang", "red_eyes"])
    assert [(c["tag"], c["added"]) for c in chips] == [
        ("red_eyes", False),
        ("fang", True),
    ]
    assert (stem, strength, forced) == ("alt", recipes.DEFAULT_STRENGTH, True)

    _, stem, strength, _ = recipes.apply_edits([], cands, {"lora": ""})
    assert (stem, strength) == (None, None)


def test_character_lora_wins_and_each_file_goes_in_once():
    picks = merge_loras(
        [{"name": "chars/hu_tao_v2.safetensors", "strength": 0.8}],
        [
            {"name": "hu_tao_v2", "strength": 0.3},
            {"name": "styles/flat_color_xl.safetensors", "strength": 0.5},
        ],
    )
    assert [(p.name, p.strength) for p in picks] == [
        ("chars/hu_tao_v2.safetensors", 0.8),
        ("styles/flat_color_xl.safetensors", 0.5),
    ]


def _loras(rows):
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_loras),
            [{"image_id": i, "name": n, "strength": s} for i, n, s in rows],
        )


def _library(seed):
    look = ("red_eyes", "twintails", "porkpie_hat", "1girl")
    who = "hu_tao_(genshin_impact)"
    for i in range(4):
        seed(f"L1:h{i}", tags=(who, f"prompt:{who}", *look), score=4 if i == 0 else 0)
    seed("L1:h4", tags=(f"prompt:{who}", "porkpie_hat"))
    for i in range(10):
        seed(f"L1:x{i}", tags=("1girl", "smile"))
    _loras(
        [(f"L1:h{i}", "hu_tao_v2", 0.8) for i in range(4)]
        + [(f"L1:h{i}", "flat_color_xl", 0.5) for i in range(5)]
        + [(f"L1:x{i}", "flat_color_xl", 0.5) for i in range(10)]
    )


async def test_recipe_edit_and_queue(client, comfy, seed, monkeypatch):  # noqa: F811
    monkeypatch.setattr(
        tag_categories,
        "load",
        _chars("hu_tao_(genshin_impact)", hu_tao="genshin_impact"),
    )
    await asyncio.to_thread(_library, seed)
    await client.post("/generate/comfyui/refresh")

    r = (await client.get("/generate/recipes/hu_tao_(genshin_impact)")).json()
    assert r["tag"] == "hu_tao_(genshin_impact)"
    assert [c["tag"] for c in r["identity"]] == ["red_eyes", "twintails"]
    assert r["outfit"] == ["porkpie_hat"]
    assert r["gender"] == "girl"
    assert r["identity_images"] == 5
    # The style LoRA on every image loses; the stem resolves to its file.
    assert r["lora"] == {
        "stem": "hu_tao_v2",
        "file": "chars/hu_tao_v2.safetensors",
        "strength": 0.8,
        "images": 4,
    }
    assert [c["stem"] for c in r["candidates"]] == ["hu_tao_v2"]

    r = (
        await client.put(
            "/generate/recipes/hu_tao_(genshin_impact)",
            json={"dropped": ["twintails"], "strength": 0.6},
        )
    ).json()
    assert r["identity"][1] == {"tag": "twintails", "dropped": True, "added": False}
    r = (
        await client.put(
            "/generate/recipes/hu_tao_(genshin_impact)", json={"added": ["hair flower"]}
        )
    ).json()
    assert r["identity"][-1] == {"tag": "hair_flower", "dropped": False, "added": True}
    assert r["lora"]["strength"] == 0.6 and r["strength_edited"] is True
    r = (
        await client.put("/generate/recipes/hu_tao_(genshin_impact)", json={"lora": ""})
    ).json()
    assert r["lora"] is None and r["lora_edited"] is True
    bad = await client.put(
        "/generate/recipes/hu_tao_(genshin_impact)", json={"strength": "x"}
    )
    assert bad.status_code == 400
    # A gender set by hand wins over the images' until it's cleared.
    r = (
        await client.put(
            "/generate/recipes/hu_tao_(genshin_impact)", json={"gender": "boy"}
        )
    ).json()
    assert (r["gender"], r["gender_read"], r["gender_set"]) == ("boy", "girl", True)
    r = (
        await client.put(
            "/generate/recipes/hu_tao_(genshin_impact)", json={"gender": None}
        )
    ).json()
    assert (r["gender"], r["gender_set"]) == ("girl", False)
    bad = await client.put(
        "/generate/recipes/hu_tao_(genshin_impact)", json={"gender": "cat"}
    )
    assert bad.status_code == 400
    assert (await client.get("/generate/recipes/nobody")).status_code == 404

    await make_ready(client, comfy, seed)
    body = {
        "base": "masterpiece",
        "extra": ["0__11Xx_illu", "night"],
        "character": {
            "tag": "hu_tao_(genshin_impact)",
            "label": "Hu Tao",
            "tags": ["hu_tao_(genshin_impact)", "red_eyes"],
            "lora": {"name": "chars/hu_tao_v2.safetensors", "strength": 0.8},
        },
        "loras": [{"name": "styles/flat_color_xl.safetensors", "strength": 0.5}],
        "count": 1,
    }
    res = await client.post("/generate/batches", json=body)
    assert res.status_code == 200, res.text
    batch = res.json()
    assert batch["name"] == "Hu Tao"
    graph = comfy.prompts[comfy.order[-1]]
    texts = [
        n["inputs"]["text"]
        for n in graph.values()
        if n["class_type"] == "CLIPTextEncode"
    ]
    assert (
        "masterpiece, hu_tao_\\(genshin_impact\\), red_eyes, 0__11Xx_illu, night"
        in texts
    )
    loras = [
        (n["inputs"]["lora_name"], n["inputs"]["strength_model"])
        for n in graph.values()
        if n["class_type"] == "LoraLoader"
    ]
    assert loras == [
        ("chars/hu_tao_v2.safetensors", 0.8),
        ("styles/flat_color_xl.safetensors", 0.5),
    ]

    # Requeue replays what the batch recorded, not today's recipe.
    again = await client.post(f"/generate/batches/{batch['_id']}/requeue")
    assert again.status_code == 200, again.text
    graph = comfy.prompts[comfy.order[-1]]
    assert any(
        n["inputs"].get("lora_name") == "chars/hu_tao_v2.safetensors"
        for n in graph.values()
    )


HU = "hu_tao_(genshin_impact)"


def _one_vocab(monkeypatch):
    """One vocabulary object for the whole test, as the app has between
    word-list changes: the look and wardrobe caches keep only for it."""
    vocab = tag_categories.Vocab(
        frozenset({HU}),
        {"hu_tao": tag_categories.Candidate("genshin_impact", HU)},
    )

    async def load():
        return vocab

    monkeypatch.setattr(tag_categories, "load", load)


def _count_looks(monkeypatch) -> list[int]:
    looked: list[int] = []
    real = characters.signature_counts

    async def counting(*args, **kwargs):
        looked.append(1)
        return await real(*args, **kwargs)

    monkeypatch.setattr(characters, "signature_counts", counting)
    return looked


async def test_a_tag_write_reaches_the_cached_look(client, seed, monkeypatch):
    _one_vocab(monkeypatch)
    await asyncio.to_thread(_library, seed)
    looked = _count_looks(monkeypatch)
    first = await recipes.wardrobe(HU)
    page = (await client.get("/tags/character", params={"tag": HU})).json()
    assert "long_coat" not in first["outfit"]
    assert "long_coat" not in {s["tag"] for s in page["signature"]}
    # Read once: the page, the wardrobe and the recipe share one look.
    await recipes.recipe(HU)
    assert await recipes.wardrobe(HU) == first and len(looked) == 1
    # A tag write, with no one clearing anything by hand.
    for i in range(4):
        await image_tags.apply_manual(f"L1:h{i}", ["long_coat"])
    assert "long_coat" in (await recipes.wardrobe(HU))["outfit"]
    page = (await client.get("/tags/character", params={"tag": HU})).json()
    assert "long_coat" in {s["tag"] for s in page["signature"]}
    assert len(looked) == 2


async def test_a_cached_wardrobe_survives_its_callers(client, seed, monkeypatch):
    _one_vocab(monkeypatch)
    await asyncio.to_thread(_library, seed)
    first = await recipes.wardrobe(HU)
    snapshot = {k: list(v) if isinstance(v, list) else v for k, v in first.items()}
    first["outfit"].append("ball_gown")
    first["names"].clear()
    first["count"] = 0
    assert await recipes.wardrobe(HU) == snapshot
    # The look itself can't be changed in place.
    look = await characters.look_of(0, HU, [HU], {HU: HU}, [])
    assert isinstance(look.signature, tuple)
    with pytest.raises(dataclasses.FrozenInstanceError):
        look.images = 0  # type: ignore[misc]
