"""Prompt guessing: picking the prompt and negative out of a graph the
structural walk can't read, by quality keywords."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import gen_metadata, reproject
from moire.services.prompt_guess import (
    DEFAULT_KEYWORDS,
    Candidate,
    Keywords,
    clean_keywords,
    pick,
)

POS = "masterpiece, best quality, 1girl, smile"
NEG = "worst quality, low quality, blurry, bad hands"


def guess(cands, keywords=DEFAULT_KEYWORDS, **known):
    """(prompt text, negative text) picked from ``(text, shown)`` pairs."""
    got = pick([Candidate(*c) for c in cands], keywords, **known)
    return tuple(got[f].text if f in got else None for f in ("prompt", "negative"))


def test_picks_each_side_by_keywords():
    assert guess([(POS, False), (NEG, False)]) == (POS, NEG)


def test_shown_text_beats_a_longer_static_widget():
    preset = POS + ", " + ", ".join(f"character {i}" for i in range(20))
    ran = POS + ", red scarf"
    assert guess([(preset, False), (ran, True)])[0] == ran


def test_more_hits_then_longer_wins():
    fragment = "masterpiece, best quality, absurdres"
    full = "masterpiece, best quality, 1girl, smile, red scarf, outdoors"
    assert guess([(full, False), (fragment, False)])[0] == fragment
    longer = full + ", night"
    assert guess([(full, False), (longer, False)])[0] == longer


def test_short_and_mixed_texts_are_not_candidates():
    # a name, a path, a setting; and a text as positive as it is negative
    cands = [
        ("masterpiece", False),
        ("model.safetensors", False),
        ("masterpiece, worst quality, cat", False),
    ]
    assert guess(cands) == (None, None)


def test_known_sides_are_kept_and_not_reused():
    assert guess([(POS, False), (NEG, False)], prompt="mine") == (
        None,
        NEG,
    )
    # the known prompt can't come back as the negative
    assert guess([(NEG, False)], prompt=NEG) == (None, None)


def test_empty_keywords_guess_nothing():
    none = Keywords(frozenset(), frozenset())
    assert guess([(POS, False), (NEG, False)], none) == (None, None)


def test_keywords_match_any_spelling_and_emphasis():
    text = "(Masterpiece:1.2), ((best_quality)), cat, dog"
    assert guess([(text, False)])[0] == text


def test_clean_keywords():
    assert clean_keywords([" Best Quality ", "best_quality", "", "lowres"]) == [
        "best_quality",
        "lowres",
    ]
    with pytest.raises(ValueError):
        clean_keywords("masterpiece")


# A remote-queue graph: no local sampler, the prompt reaches the worker
# through custom nodes, a display node shows what ran.
REMOTE = {
    "1": {"class_type": "Text Multiline", "inputs": {"text": POS}},
    "2": {
        "class_type": "ShowText|pysssss",
        "inputs": {"text": ["3", 0], "text_0": POS + ", red scarf"},
    },
    "3": {"class_type": "StringConcatenate", "inputs": {"string_a": ["1", 0]}},
    "4": {"class_type": "JSONKeyManipulatorNode", "inputs": {"new_value_str": NEG}},
    "5": {"class_type": "RemoteQueueWorker", "inputs": {"remote_url": "http://x/"}},
}


def test_extract_guesses_only_what_the_graph_walk_missed():
    g = gen_metadata.extract({"source": "comfyui", "prompt": REMOTE})
    assert g["prompt"] == POS + ", red scarf"
    assert g["negative"] == NEG
    assert g["guessed"] == ["prompt", "negative"]
    assert g["guess_paths"] == {
        "prompt": "prompt.2.inputs.text_0",
        "negative": "prompt.4.inputs.new_value_str",
    }
    assert "red_scarf" in g["prompt_terms"]

    walked = {
        **REMOTE,
        "9": {
            "class_type": "KSampler",
            "inputs": {"seed": 1, "positive": ["10", 0], "negative": ["11", 0]},
        },
        "10": {"class_type": "CLIPTextEncode", "inputs": {"text": "cat, dog, bird"}},
        "11": {"class_type": "CLIPTextEncode", "inputs": {"text": "ugly"}},
    }
    g = gen_metadata.extract({"source": "comfyui", "prompt": walked})
    assert (g["prompt"], g["negative"], g["guessed"]) == ("cat, dog, bird", "ugly", [])


def test_a_guess_path_pins_to_the_same_text():
    raw = {"source": "comfyui", "prompt": REMOTE}
    paths = gen_metadata.extract(raw)["guess_paths"]
    pinned = gen_metadata.extract(
        raw, {"fields": {f: [path] for f, path in paths.items()}}
    )
    assert pinned["guessed"] == []
    assert pinned["prompt"] == POS + ", red scarf"
    assert pinned["negative"] == NEG


def test_display_widgets_in_the_editor_graph_are_candidates():
    workflow = {
        "nodes": [{"id": 7, "type": "ShowText|pysssss", "widgets_values": [[POS]]}]
    }
    g = gen_metadata.extract({"source": "comfyui", "prompt": {}, "workflow": workflow})
    assert g["prompt"] == POS
    assert g["guess_paths"]["prompt"] == "workflow.nodes.0.widgets_values.0.0"


def test_a1111_is_never_guessed():
    g = gen_metadata.extract({"source": "a1111", "parameters": "cat, dog"})
    assert g["guessed"] == []


@pytest.mark.asyncio
async def test_keyword_settings_round_trip_and_reproject(client, seed):
    seed("L1:a", tags=())
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id="L1:a",
                library_id="L1",
                workflow_sig=None,
                raw={"source": "comfyui", "prompt": REMOTE},
            )
        )
    reproject.reproject_library("L1")

    got = (await client.get("/rules/guess-keywords")).json()
    assert got["guess_positive"] == got["default_positive"]
    assert got["guessed_images"] == 1

    saved = (
        await client.put(
            "/rules/guess-keywords",
            json={"guess_positive": ["Red Scarf"], "guess_negative": []},
        )
    ).json()
    assert saved["guess_positive"] == ["red_scarf"]
    assert saved["guess_negative"] == []

    # what the background reprojection does, run inline
    reproject.reproject_library("L1")
    gen = (await client.get("/images/L1:a")).json()["gen"]
    assert gen["prompt"] == POS + ", red scarf"
    assert gen["negative"] is None
    assert gen["guessed"] == ["prompt"]
