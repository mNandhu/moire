import json
import random
from pathlib import Path

import pytest

from moire.services import builtin_generator
from moire.services.generator_graph import (
    GraphError,
    LoraPick,
    build_prompt,
    has_save_image,
    lora_insertion,
    lora_stem,
    seeds_for,
    splice_loras,
    split_requests,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _chain_graph():
    # A real library graph: checkpoint 50 -> five stock LoraLoaders
    # (66 -> 68 -> 67 -> 65 -> 69) -> model patch 74 / CLIPSetLastLayer 64.
    return json.loads((FIXTURES / "comfy_lora_chain.json").read_text())


def _consumers(graph, ref):
    return sorted(
        (nid, name)
        for nid, n in graph.items()
        for name, v in n["inputs"].items()
        if v == ref
    )


def test_lora_stem():
    assert lora_stem("styles/flat_color_xl.safetensors") == "flat_color_xl"
    assert lora_stem("a\\b\\x.pt") == "x"
    assert lora_stem("v1.5_style") == "v1.5_style"
    assert lora_stem("plain") == "plain"


def test_lora_insertion_walks_past_existing_stock_loaders():
    assert lora_insertion(_chain_graph(), "50") == (["69", 0], ["69", 1])


def test_lora_insertion_on_builtin_is_the_checkpoint():
    assert lora_insertion(builtin_generator.graph(), "4") == (["4", 0], ["4", 1])


def test_splice_rewires_every_consumer_to_chain_end():
    g = _chain_graph()
    splice_loras(
        g,
        ["69", 0],
        ["69", 1],
        [LoraPick("a.safetensors", 0.7), LoraPick("b.safetensors", 0.4)],
    )
    new = [
        nid
        for nid, n in g.items()
        if n["inputs"].get("lora_name") in ("a.safetensors", "b.safetensors")
    ]
    assert len(new) == 2
    first, last = sorted(new, key=int)
    assert g[first]["inputs"]["model"] == ["69", 0]
    assert g[first]["inputs"]["clip"] == ["69", 1]
    assert g[last]["inputs"]["model"] == [first, 0]
    assert g[last]["inputs"]["strength_clip"] == 0.4
    # The old outputs now feed only the chain; downstream reads the chain's end.
    assert _consumers(g, ["69", 0]) == [(first, "model")]
    assert _consumers(g, ["69", 1]) == [(first, "clip")]
    assert g["74"]["inputs"]["model"] == [last, 0]
    assert g["64"]["inputs"]["clip"] == [last, 1]


def test_splice_overrides_strength_of_a_lora_the_graph_already_loads():
    g = _chain_graph()
    before = len(g)
    splice_loras(
        g, ["69", 0], ["69", 1], [LoraPick("other/princess_xl_v2.safetensors", 0.9)]
    )
    assert len(g) == before
    assert g["69"]["inputs"]["strength_model"] == 0.9
    assert g["69"]["inputs"]["strength_clip"] == 0.9


def test_splice_without_clip_uses_model_only_loader():
    g = builtin_generator.graph()
    splice_loras(g, ["4", 0], None, [LoraPick("x.safetensors", 1.0)])
    (nid,) = [k for k, n in g.items() if n["class_type"] == "LoraLoaderModelOnly"]
    assert g[nid]["inputs"] == {
        "lora_name": "x.safetensors",
        "strength_model": 1.0,
        "model": ["4", 0],
    }
    assert g["3"]["inputs"]["model"] == [nid, 0]
    assert g["6"]["inputs"]["clip"] == ["4", 1]


def test_splice_unknown_node_raises():
    with pytest.raises(GraphError):
        splice_loras(builtin_generator.graph(), ["99", 0], None, [LoraPick("x", 1.0)])


def test_build_prompt_writes_slots_and_leaves_input_alone():
    base = builtin_generator.graph()
    g = build_prompt(
        base,
        builtin_generator.slots(),
        {
            "positive": "1girl, solo",
            "negative": "lowres",
            "seed": 42,
            "width": 1024,
            "height": 1024,
            "batch_size": 2,
            "checkpoint": "illustriousXL_v01.safetensors",
            "loras": [LoraPick("flat.safetensors", 0.8)],
        },
    )
    assert g["6"]["inputs"]["text"] == "1girl, solo"
    assert g["7"]["inputs"]["text"] == "lowres"
    assert g["3"]["inputs"]["seed"] == 42
    assert g["5"]["inputs"] == {"width": 1024, "height": 1024, "batch_size": 2}
    assert g["4"]["inputs"]["ckpt_name"] == "illustriousXL_v01.safetensors"
    assert g["3"]["inputs"]["model"] != ["4", 0]
    assert base == builtin_generator.graph()
    assert has_save_image(g)


def test_build_prompt_refuses_a_slot_on_a_link():
    slots = builtin_generator.slots() | {"positive": ["3", "model"]}
    with pytest.raises(GraphError):
        build_prompt(builtin_generator.graph(), slots, {"positive": "x", "seed": 1})


def test_split_requests():
    assert split_requests(8, 2) == [2, 2, 2, 2]
    assert split_requests(7, 3) == [3, 3, 1]
    assert split_requests(1, 4) == [1]
    assert split_requests(3, None) == [None, None, None]
    assert split_requests(0, 2) == []


def test_seeds_fixed_counts_up_and_random_differs():
    assert seeds_for(3, fixed=10) == [10, 11, 12]
    r = seeds_for(4, rng=random.Random(1))
    assert len(set(r)) == 4
