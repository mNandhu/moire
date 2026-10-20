"""Generator setup discovery against real workflow shapes (prompt texts
replaced): a txt2img with hires, FaceDetailer and Ultimate SD Upscale; an
img2img whose positive is joined at run time; a remote workflow with no
sampler at all."""

import json
from pathlib import Path

import pytest

from src.services import builtin_generator
from src.services.generator_discovery import (
    base_sampler,
    check_slots,
    discover,
    seed_groups,
)
from src.services.generator_graph import GraphError, build_prompt

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str):
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
def hires():
    return _load("graph_hires_detailer.json")


@pytest.fixture
def runtime():
    return _load("graph_runtime_prompt.json")


def test_builtin_graph_finds_the_builtin_slots():
    d = discover(builtin_generator.graph())
    want = builtin_generator.slots()
    want.pop("checkpoint")  # never offered for a custom Generator
    got = dict(d["slots"])
    assert got.pop("per_request") == 1
    assert got == want
    assert check_slots(builtin_generator.graph(), d["slots"]) == []


def test_hires_graph(hires):
    d = discover(hires)
    s = d["slots"]
    # The first KSampler, not the detailer or the upscaler after it.
    assert d["found"]["sampler"]["node"] == "16"
    assert s["positive"] == ["14", "text"] and s["negative"] == ["13", "text"]
    # Ratio-select latent: a batch size but no width / height to write.
    assert s["batch_size"] == ["25", "batch_size"] and s["per_request"] == 4
    assert "width" not in s and "height" not in s
    assert s["steps"] == ["16", "steps"] and s["cfg"] == ["16", "cfg"]
    # After the graph's own four LoRAs.
    assert s["lora_model"] == ["40", 0] and s["lora_clip"] == ["40", 1]
    assert len(d["found"]["lora"]["existing"]) == 4
    # Three passes, three different seeds: three groups, all ticked.
    assert [len(g["inputs"]) for g in d["seeds"]] == [1, 1, 1]
    assert sorted(s["seeds"]) == [["16", "seed"], ["26", "seed"], ["34", "seed"]]
    assert [o["saves"] for o in d["outputs"]].count(True) == 1
    assert d["input_images"] == []
    # The picker keeps prompt text, not detailer modes.
    assert [t["path"] for t in d["text_inputs"]] == [["13", "text"], ["14", "text"]]
    assert check_slots(hires, s) == []


def test_runtime_prompt_needs_a_pick(runtime):
    d = discover(runtime)
    pos = d["found"]["positive"]
    # The encoder's text is a join of two text nodes: offered, not chosen.
    assert pos["path"] == ["11", "text"] and pos["replaces_link"]
    assert "50.text" in pos["text"] and "137.string" in pos["text"]
    assert "positive" not in d["slots"]
    assert check_slots(runtime, d["slots"]) == ["Choose the positive prompt's node"]
    reach = {tuple(t["path"]): t["reaches"] for t in d["text_inputs"]}
    assert (
        reach[("50", "text")] == "positive" and reach[("137", "string")] == "positive"
    )
    assert reach[("12", "text")] == "negative"
    assert reach[("90", "text")] is None  # the detailer's own prompt
    # Group-node ids ("111:0") are listed like any other.
    assert ("111:0", "text") in reach
    assert d["input_images"][0]["node"] == "72"
    # No latent size: it encodes the input image.
    assert "width" not in d["slots"] and "batch_size" not in d["slots"]


def test_replacing_a_joined_prompt(runtime):
    slots = {**discover(runtime)["slots"], "positive": ["11", "text"]}
    assert check_slots(runtime, slots) == ["The positive prompt's input is a link"]
    slots["replace_links"] = ["positive"]
    assert check_slots(runtime, slots) == []
    g = build_prompt(
        runtime, slots, {"positive": "1girl", "negative": "bad", "seed": 5}
    )
    assert g["11"]["inputs"]["text"] == "1girl"
    assert runtime["11"]["inputs"]["text"] == ["18", 0]  # snapshot untouched
    with pytest.raises(GraphError):
        build_prompt(
            runtime, {**slots, "replace_links": []}, {"positive": "x", "seed": 1}
        )


def test_no_sampler_graph():
    g = _load("graph_no_sampler.json")
    d = discover(g)
    assert d["found"] == {"sampler": None}
    assert "positive" not in d["slots"] and "lora_model" not in d["slots"]
    # Without a sampler nothing is known to reach a prompt.
    assert all(t["reaches"] is None for t in d["text_inputs"])
    assert check_slots(g, d["slots"])[:2] == [
        "Choose the positive prompt's node",
        "Choose the negative prompt's node",
    ]


def test_base_sampler_skips_a_second_pass_listed_first():
    g = builtin_generator.graph()
    # A hires pass whose latent comes out of the first sampler, keyed first.
    g = {
        "1": {
            "class_type": "KSampler",
            "inputs": {"seed": 1, "positive": ["6", 0], "latent_image": ["2", 0]},
        },
        "2": {"class_type": "LatentUpscale", "inputs": {"samples": ["3", 0]}},
        **g,
    }
    assert base_sampler(g) == "3"


def test_linked_seed_is_written_on_its_seed_node():
    g = {
        "1": {"class_type": "Seed", "inputs": {"seed": 42}},
        "2": {"class_type": "KSampler", "inputs": {"seed": ["1", 0], "positive": None}},
        "3": {"class_type": "FaceDetailer", "inputs": {"seed": ["1", 0]}},
        "4": {"class_type": "KSampler", "inputs": {"seed": 0, "positive": None}},
    }
    groups = seed_groups(g)
    assert groups[0]["value"] == 42
    assert groups[0]["inputs"][0]["path"] == ["1", "seed"]
    assert [u["node"] for u in groups[0]["inputs"][0]["used_by"]] == ["2", "3"]
    assert groups[1]["inputs"][0]["path"] == ["4", "seed"]


def test_unet_graph_gets_a_model_only_chain():
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux.safetensors"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "a"}},
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "p", "clip": ["2", 0]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "n", "clip": ["2", 0]},
        },
        "5": {
            "class_type": "EmptySD3LatentImage",
            "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
                "seed": 3,
            },
        },
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0]}},
    }
    s = discover(g)["slots"]
    assert s["lora_model"] == ["1", 0] and s["lora_clip"] is None
    assert s["width"] == ["5", "width"]
    assert check_slots(g, s) == []


def test_check_slots_problems(hires):
    s = discover(hires)["slots"]
    assert "Positive and negative can't be the same input" in check_slots(
        hires, {**s, "negative": s["positive"]}
    )
    assert check_slots(hires, {**s, "positive": ["99", "text"]}) == [
        "The positive prompt's node isn't in this workflow"
    ]
    assert check_slots(hires, {**s, "steps": ["16", "model"]}) == [
        "Steps isn't a value in this workflow"
    ]
    no_save = {k: v for k, v in hires.items() if v["class_type"] != "SaveImage"}
    assert check_slots(no_save, s)[-1].startswith("Add a Save Image node")
