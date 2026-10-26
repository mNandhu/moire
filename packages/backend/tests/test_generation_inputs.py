"""A queue body -> the inputs a batch keeps, and "Queue again" replaying them."""

from __future__ import annotations

import pytest

from moire.services.generation_compose import batch_name
from moire.services.generation_inputs import (
    DERIVED_KEYS,
    REPLAY_KEYS,
    build_batch_inputs,
    replay_body,
)

GEN = {
    "kind": "builtin",
    "name": "Built-in",
    "slots": {
        "batch_size": ["5", "batch_size"],
        "checkpoint": ["4", "ckpt_name"],
        "steps": ["3", "steps"],
        "cfg": ["3", "cfg"],
    },
}
CHARACTER = {
    "tag": "hu_tao_(genshin_impact)",
    "label": "Hu Tao",
    "tags": ["hu_tao_(genshin_impact)", "red_eyes"],
    "lora": {"name": "hutao.safetensors", "strength": 0.8},
    "outfit": {"id": "o1", "name": "Funeral", "tags": ["black_coat"]},
}
LAYERED = {
    "positive": [
        {"kind": "text", "role": "prefix", "text": "masterpiece"},
        {"kind": "character"},
        {"kind": "text", "role": "prompt", "text": "smile, garden"},
        {"kind": "embedding", "name": "good"},
    ],
    "negative": [{"kind": "text", "role": "text", "text": "lowres"}],
    "composer": {"anything": [1, 2]},
}
LEGACY = {
    "base": "1girl",
    "extra": ["smile"],
    "negative_base": "lowres",
    "negative_extra": ["blurry"],
}
COMMON = {
    "checkpoint": "a.safetensors",
    "sampling": {"steps": 20, "cfg": 5.0, "sampler": "euler"},
    "loras": [{"name": "style.safetensors", "strength": 0.5}],
    "characters": [CHARACTER],
    "width": 832,
    "height": 1216,
    "count": 5,
    "per_request": 2,
    "seed": {"mode": "fixed", "value": 42},
}


@pytest.mark.parametrize("prompt", [LAYERED, LEGACY], ids=["layered", "legacy"])
def test_every_kept_input_is_replayed_or_derived(prompt):
    inputs = build_batch_inputs({**COMMON, **prompt}, GEN, {}).inputs
    assert set(REPLAY_KEYS).isdisjoint(DERIVED_KEYS)
    # A key queue_batch keeps that requeue neither replays nor derives would
    # be dropped silently by "Queue again".
    assert set(inputs) <= set(REPLAY_KEYS) | set(DERIVED_KEYS)


@pytest.mark.parametrize("prompt", [LAYERED, LEGACY], ids=["layered", "legacy"])
def test_queue_again_makes_the_same_inputs(prompt):
    first = build_batch_inputs({**COMMON, **prompt}, GEN, {"builtin_per_request": 3})
    again = build_batch_inputs(
        replay_body(first.inputs), GEN, {"builtin_per_request": 3}
    )
    assert again.inputs == first.inputs
    assert again.sizes == first.sizes == [2, 2, 1]
    assert again.seeds == first.seeds
    assert again.name_words == first.name_words


def test_only_a_chosen_batch_size_is_replayed():
    first = build_batch_inputs({"count": 4}, GEN, {"builtin_per_request": 1})
    body = replay_body(first.inputs)
    assert body["per_request"] is None
    # Today's setting applies to the replay.
    assert build_batch_inputs(body, GEN, {"builtin_per_request": 2}).sizes == [2, 2]


def test_a_requeued_test_run_is_a_plain_batch():
    first = build_batch_inputs(LEGACY, GEN, {}, test=True)
    assert first.inputs["test"] is True
    assert (
        build_batch_inputs(replay_body(first.inputs), GEN, {}).inputs["test"] is False
    )


def test_prompt_text_and_name_words():
    layered = build_batch_inputs({**COMMON, **LAYERED}, GEN, {})
    assert layered.inputs["positive_text"] == (
        "masterpiece, hu_tao_\\(genshin_impact\\), red_eyes, black_coat, "
        "smile, garden, embedding:good"
    )
    assert layered.inputs["negative_text"] == "lowres"
    assert layered.name_words == ["smile", "garden"]
    legacy = build_batch_inputs({**COMMON, **LEGACY}, GEN, {})
    assert legacy.inputs["negative_text"] == "lowres, blurry"
    assert legacy.name_words == ["smile"]


def test_batch_name():
    def name(*chars, extra=()):
        return batch_name(
            number=7, generator="Built-in", characters=list(chars), extra=extra
        )

    worn = {**CHARACTER, "outfit": {"id": "default", "name": "Default", "tags": []}}
    renamed = {**worn, "outfit": {"id": "default", "name": "Casual", "tags": []}}
    other = {"tag": "zhongli", "label": "", "tags": []}
    assert name(CHARACTER) == "Hu Tao, Funeral"
    # The untouched Default outfit isn't news; a renamed one is.
    assert name(worn) == "Hu Tao"
    assert name(renamed) == "Hu Tao, Casual"
    # Several characters: names only, the tag where there's no label.
    assert name(CHARACTER, other) == "Hu Tao & zhongli"
    assert name(extra=["red_dress"]) == "Built-in, red dress"
    assert name() == "Batch 7"
