"""Computing a runtime-built prompt from the graph, so a display node's stale
cache (the previous run's text) doesn't win."""

from src.services import gen_metadata
from src.services.text_eval import evaluate

HEADER = "masterpiece, best quality"
CARD = "<tags>\n1girl, arima kana, beach\n</tags>\n<character>red hair</character>"

# A remote-queue graph like the user's: a header plus parts chopped out of a
# card by regex, joined; ShowText shows the result (with last run's text).
GRAPH = {
    "37": {"class_type": "Text Multiline", "inputs": {"text": HEADER}},
    "41": {
        "class_type": "Primitive string multiline [Crystools]",
        "inputs": {"string": CARD},
    },
    "71": {
        "class_type": "Text Find and Replace",
        "inputs": {"text": ["41", 0], "find": "\\n", "replace": ""},
    },
    "68": {
        "class_type": "Regex Text Chopper -noEmbryo",
        "inputs": {"regex": "<character>(.*?)</character>", "text": ["71", 0]},
    },
    "69": {
        "class_type": "Regex Text Chopper -noEmbryo",
        "inputs": {"regex": "<tags>(.*?)</tags>", "text": ["71", 0]},
    },
    "35": {
        "class_type": "TextConcat",
        "inputs": {
            "delimiter": ",",
            "text1": ["37", 0],
            "text2": ["68", 4],
            "text3": ["69", 4],
            "text4": "",
        },
    },
    "26": {
        "class_type": "Text Find and Replace",
        "inputs": {"text": ["35", 0], "find": ",,", "replace": ","},
    },
    "65": {
        "class_type": "ShowText|pysssss",
        "inputs": {"text": ["26", 0], "text_0": "1girl, kuchiki rukia (last run)"},
    },
}
RAN = "masterpiece, best quality,red hair,1girl, arima kana, beach"


def test_evaluates_the_string_chain():
    assert evaluate(GRAPH, ["26", 0]) == RAN


def test_unknown_nodes_and_wildcards_give_up():
    g = {
        **GRAPH,
        "41": {"class_type": "Florence2Run", "inputs": {"image": ["1", 0]}},
    }
    assert evaluate(g, ["26", 0]) is None
    wild = {
        "1": {
            "class_type": "Text Multiline",
            "inputs": {"text": "a {red|blue} cat", "dynamic_prompts": True},
        }
    }
    assert evaluate(wild, ["1", 0]) is None


def test_a_pin_on_the_display_reads_what_ran():
    raw = {"source": "comfyui", "prompt": GRAPH}
    g = gen_metadata.extract(raw, {"fields": {"prompt": ["prompt.65.inputs.text_0"]}})
    assert g["prompt"] == RAN
    # where the chain can't be computed, the cache is still used
    blind = {
        **GRAPH,
        "41": {"class_type": "Florence2Run", "inputs": {"image": ["1", 0]}},
    }
    g = gen_metadata.extract(
        {"source": "comfyui", "prompt": blind},
        {"fields": {"prompt": ["prompt.65.inputs.text_0"]}},
    )
    assert g["prompt"] == "1girl, kuchiki rukia (last run)"


def test_a_guess_from_the_display_uses_what_ran():
    g = gen_metadata.extract({"source": "comfyui", "prompt": GRAPH})
    assert g["guessed"] == ["prompt"]
    assert g["prompt"] == RAN
    assert g["guess_paths"]["prompt"] == "prompt.65.inputs.text_0"


def test_a_sampler_walk_through_the_chain_computes_it():
    g = gen_metadata.extract(
        {
            "source": "comfyui",
            "prompt": {
                **GRAPH,
                "9": {
                    "class_type": "KSampler",
                    "inputs": {"seed": 1, "positive": ["10", 0], "negative": ["11", 0]},
                },
                "10": {"class_type": "CLIPTextEncode", "inputs": {"text": ["26", 0]}},
                "11": {"class_type": "CLIPTextEncode", "inputs": {"text": "ugly"}},
            },
        }
    )
    assert g["prompt"] == RAN
