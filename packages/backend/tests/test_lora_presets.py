"""Style LoRA activation presets: the words a LoRA wants, suggested from the
file's training tags and from the user's own images."""

from __future__ import annotations

import asyncio
import json

import pytest

from src.services import lora_presets
from tests.test_recipes import _loras


def test_clean_takes_the_stem_and_checks_strength():
    out = lora_presets.clean(
        {"lora": "styles/niji.safetensors", "name": " glitch ", "text": " a, b "},
        new=True,
    )
    assert out == {"stem": "niji", "name": "glitch", "text": "a, b"}
    assert lora_presets.clean({"strength": 0.555}, new=False) == {"strength": 0.56}
    assert lora_presets.clean({"strength": None}, new=False) == {"strength": None}
    for bad in ({"strength": 3}, {"strength": True}, {"strength": "1"}):
        with pytest.raises(lora_presets.PresetError):
            lora_presets.clean(bad, new=False)
    with pytest.raises(lora_presets.PresetError):
        lora_presets.clean({"name": "x"}, new=True)


def test_file_words_puts_the_trigger_phrase_first():
    meta = {
        "modelspec.trigger_phrase": "0__11Xx_illu",
        "ss_tag_frequency": json.dumps(
            {
                "10_a": {"0__11Xx_illu": 40, "1girl": 30, "glitch": 12},
                "5_b": {"glitch": 20, "1girl": 5},
            }
        ),
    }
    assert lora_presets.file_words(meta, limit=3) == ["0__11Xx_illu", "1girl", "glitch"]
    assert lora_presets.file_words({"ss_tag_frequency": "not json"}) == []
    assert lora_presets.file_words(None) == []


def test_library_words_need_share_and_lift():
    here = {"niji_style": 9, "1girl": 9, "glitch": 4, "rare": 1}
    everywhere = {"niji_style": 9, "1girl": 80, "glitch": 5, "rare": 1}
    # 1girl is everywhere (no lift); glitch and rare are in too few of its images.
    assert lora_presets.library_words(here, 10, everywhere, 100) == [("niji_style", 9)]
    assert lora_presets.library_words(here, 1, everywhere, 100) == []


def _library(seed):
    # Three prompts with the LoRA; the first made three images (its scene
    # words must not count three times).
    made = [
        ("a", "swing"),
        ("a", "swing"),
        ("a", "swing"),
        ("b", "beach"),
        ("c", "city"),
    ]
    for i, (p, scene) in enumerate(made):
        seed(
            f"L1:n{i}",
            tags=("prompt:0__11Xx_illu", "prompt:1girl", f"prompt:{scene}"),
            gen={"prompt": p},
        )
    for i in range(12):
        seed(f"L1:o{i}", tags=("prompt:1girl", "prompt:smile"), gen={"prompt": f"o{i}"})
    _loras([(f"L1:n{i}", "niji", 0.6) for i in range(len(made))])


async def test_presets_crud_and_suggestions(client, seed):
    lora_presets._total = None
    await asyncio.to_thread(_library, seed)
    made = (
        await client.post(
            "/generate/lora-presets",
            json={
                "lora": "styles/niji.safetensors",
                "name": "glitch",
                "text": "0__11Xx_illu, glitch",
                "strength": 0.6,
            },
        )
    ).json()
    assert (made["stem"], made["strength"]) == ("niji", 0.6)
    r = await client.put(
        f"/generate/lora-presets/{made['_id']}", json={"strength": None}
    )
    assert r.json()["strength"] is None
    assert [p["name"] for p in (await client.get("/generate/lora-presets")).json()] == [
        "glitch"
    ]
    assert (
        await client.post("/generate/lora-presets", json={"name": "x"})
    ).status_code == 400
    assert (await client.put("/generate/lora-presets/nope", json={})).status_code == 404

    # No ComfyUI connected: library words only.
    words = (
        await client.get(
            "/generate/lora-words", params={"name": "styles/niji.safetensors"}
        )
    ).json()
    assert words == [{"word": "0__11Xx_illu", "sources": ["library"], "prompts": 3}]

    assert (
        await client.delete(f"/generate/lora-presets/{made['_id']}")
    ).status_code == 200
    assert (await client.get("/generate/lora-presets")).json() == []


class _FakeClient:
    async def lora_metadata(self, name):
        return {
            "ss_tag_frequency": json.dumps(
                {
                    "a": {
                        "0_11xx_b": 40,
                        "1girl": 39,
                        "looking at viewer": 30,
                        "0__11Xx_illu": 25,
                        "background": 3,
                    }
                }
            )
        }


async def test_file_words_skip_tags_common_in_the_library(client, seed):
    lora_presets._total = None
    await asyncio.to_thread(_library, seed)
    words = await lora_presets.suggestions("niji.safetensors", _FakeClient())
    # 1girl is in every prompt without the LoRA; the trigger is in every
    # prompt with it, which doesn't make it common. "background" is in too few
    # captions.
    assert [(w["word"], w["sources"]) for w in words] == [
        ("0_11xx_b", ["file"]),
        ("looking at viewer", ["file"]),
        ("0__11Xx_illu", ["file", "library"]),
    ]


async def test_character_names_come_from_the_tagger_vocab(client, monkeypatch):
    from src.services import tag_categories

    async def fake():
        return tag_categories.vocab({"fern_(sousou_no_frieren)", "nahida"}, set())

    monkeypatch.setattr(tag_categories, "load", fake)
    r = await client.get("/generate/character-names")
    assert r.json() == ["fern_(sousou_no_frieren)", "nahida"]


class _SpacedClient:
    async def lora_metadata(self, name):
        # The library spells it 0__11Xx_illu; a caption tag with a space
        # would be the same word.
        return {
            "ss_tag_frequency": json.dumps({"a": {"1girl": 50, "0__11Xx illu": 40}})
        }


async def test_one_word_in_two_spellings_is_offered_once(client, seed):
    lora_presets._total = None
    await asyncio.to_thread(_library, seed)
    words = await lora_presets.suggestions("niji.safetensors", _SpacedClient())
    # 1girl leads the captions but is common: dropped though it comes first.
    assert [(w["word"], w["sources"]) for w in words] == [
        ("0__11Xx illu", ["file", "library"])
    ]


async def test_describe_keeps_common_training_tags(client, seed):
    lora_presets._total = None
    await asyncio.to_thread(_library, seed)
    words = await lora_presets.suggestions(
        "niji.safetensors", _FakeClient(), describe=True
    )
    assert [w["word"] for w in words][:3] == ["0_11xx_b", "1girl", "looking at viewer"]
