"""The attire list loader (pure) and the build script's pure steps."""

import importlib.util
import json
from pathlib import Path

import pytest

from moire.services import attire

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_tag_groups.py"
_spec = importlib.util.spec_from_file_location("build_tag_groups", _SCRIPT)
build_script = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_script)


@pytest.fixture
def listed(tmp_path, monkeypatch):
    path = tmp_path / "tag_groups.json"
    path.write_text(
        json.dumps(
            {
                "tags": {
                    "serafuku": {
                        "category": "attire_and_body_accessories",
                        "group": "attire",
                    },
                    "thighhighs": {
                        "category": "attire_and_body_accessories",
                        "group": "legwear",
                    },
                    "necktie": {
                        "category": "body",
                        "group": "neck_and_neckwear",
                        "also": ["objects/holding_tags"],
                    },
                    "barefoot": {
                        "category": "attire_and_body_accessories",
                        "group": "nudity",
                    },
                    "skirt_lift": {
                        "category": "attire_and_body_accessories",
                        "group": "nudity",
                    },
                    "anklet": {
                        "category": "body",
                        "group": "feet",
                        "also": ["attire_and_body_accessories/accessories"],
                    },
                    "blue_eyes": {"category": "body", "group": "eyes_tags"},
                    "adjusting_scarf": {
                        "category": "body",
                        "group": "neck_and_neckwear",
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(attire, "TAG_GROUPS_PATH", path)
    attire._load.cache_clear()
    yield
    attire._load.cache_clear()


def test_lookup(listed):
    assert attire.is_attire("serafuku")
    assert not attire.is_attire("1girl")
    assert not attire.is_attire("blue_eyes")  # listed, but not worn
    # The nudity group: how a garment is cut or worn counts (exposure), an
    # action doesn't.
    assert attire.group_of("barefoot") == "exposure"
    assert not attire.is_attire("skirt_lift")
    assert attire.is_attire("necktie")  # neckwear sits under body
    assert not attire.is_attire("adjusting_scarf")  # an action, not a garment
    assert attire.is_attire("anklet")  # primary place is feet, also accessories
    assert attire.group_of("thighhighs") == "legwear"
    assert attire.category_of("blue_eyes") == "body"
    assert attire.group_of("1girl") is None


def test_spelling_is_canonicalised(listed):
    assert attire.is_attire(" Serafuku ")
    assert attire.group_of("THIGHHIGHS") == "legwear"
    assert attire.category_of("blue eyes") == "body"


def test_attire_tags_use_the_attire_group(listed):
    assert attire.attire_tags() == {
        "serafuku": "attire",
        "thighhighs": "legwear",
        "necktie": "neck_and_neckwear",
        "anklet": "accessories",
        "barefoot": "exposure",
        # Unlisted hubs.
        "jewelry": "accessories",
        "strapless": "exposure",
    }
    assert attire.all_tags("body")["blue_eyes"] == "eyes_tags"
    assert len(attire.all_tags()) == 8
    attire.all_tags()["x"] = "y"
    assert "x" not in attire.all_tags()


def test_missing_or_broken_file_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(attire, "TAG_GROUPS_PATH", tmp_path / "nope.json")
    attire._load.cache_clear()
    assert attire.all_tags() == {}
    (tmp_path / "bad.json").write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(attire, "TAG_GROUPS_PATH", tmp_path / "bad.json")
    attire._load.cache_clear()
    assert attire.all_tags() == {}
    attire._load.cache_clear()


def test_parse_drops_malformed_entries():
    good = {"category": "c", "group": "g"}
    assert attire.parse(["x"]) == {}
    got = attire.parse(
        {
            "tags": {
                "a b": good,
                "c": "g",
                "d": {"group": "g"},
                "e": {**good, "also": [1]},
            }
        }
    )
    assert got == {"a_b": ("c", "g", ()), "e": ("c", "g", ())}


def test_committed_list_is_well_formed():
    doc = json.loads(attire.TAG_GROUPS_PATH.read_text(encoding="utf-8"))
    assert list(doc["tags"]) == sorted(doc["tags"])
    assert len(attire.parse(doc)) == len(doc["tags"])
    assert attire.attire_tags()


# build script


def test_split_links_separates_groups_tags_and_noise():
    text = (
        "* [[Tag group:Headwear|Headwear]]\n"
        '* "legwear":[/wiki_pages/tag_group:legwear]\n'
        "* [[blue eyes]] and [[hat#note|a hat]]\n"
        "* [[help:dtext]] [[list_of_hats]]\n"
    )
    groups, tags = build_script.split_links(text)
    assert groups == ["tag_group:headwear", "tag_group:legwear"]
    assert tags == ["blue_eyes", "hat"]


def test_sections_cut_at_headings():
    got = build_script.sections(
        "intro\nh4. Hair colors\n[[a]]\nh6#attire. Clothing\n[[b]]"
    )
    assert got == [(None, "intro"), ("Hair colors", "[[a]]"), ("Clothing", "[[b]]")]
    assert build_script.category_name("Hair colors") == "hair_colors"


def test_walk_assigns_hub_headings_as_categories_and_inherits():
    pages = {
        "tag_groups": (
            "h4. Body\n* [[tag_group:eyes]]\nh4. Clothing\n* [[tag_group:attire]]\n"
        ),
        "tag_group:eyes": "[[blue eyes]]",
        "tag_group:attire": "h5. Hats\n[[tag_group:headwear]] [[dress]] [[tag_group:gone]]",
        "tag_group:headwear": "[[hat]] [[tag_group:attire]] [[tag_group:hats]]",
        "tag_group:hats": "[[hat]] [[beret]]",
    }
    found, missing = build_script.walk(pages.get)
    assert found["blue_eyes"] == {("body", "eyes"): 1}
    assert found["dress"] == {("clothing", "attire"): 1}
    assert found["hat"] == {("clothing", "headwear"): 2, ("clothing", "hats"): 3}
    assert found["beret"] == {("clothing", "hats"): 3}
    assert missing == ["tag_group:gone"]


def test_build_filters_to_vocab_and_picks_the_smallest_group():
    found = {
        "hat": {("attire", "headwear"): 2, ("attire", "accessories"): 1},
        "beret": {("attire", "headwear"): 2},
        "belt": {("attire", "accessories"): 1},
        "bag": {("attire", "accessories"): 1},
        "zzz": {("x", "a"): 1},
    }
    tags, dropped, ambiguous = build_script.build(
        found, {"hat", "beret", "belt", "bag"}
    )
    assert tags["hat"] == {
        "category": "attire",
        "group": "headwear",
        "also": ["attire/accessories"],
    }
    assert tags["beret"] == {"category": "attire", "group": "headwear"}
    assert list(tags) == sorted(tags)
    assert dropped == ["zzz"]
    assert ambiguous == {"hat": ["attire/accessories", "attire/headwear"]}


def test_load_vocab_keeps_general_tags_only(tmp_path):
    csv_path = tmp_path / "v.csv"
    csv_path.write_text(
        "tag_id,name,category,count\n1,Blue Eyes,0,5\n2,hatsune_miku,4,5\n3,safe,9,1\n",
        encoding="utf-8",
    )
    assert build_script.load_vocab(csv_path) == {"blue_eyes"}


def test_facets(listed):
    assert attire.facet_of("serafuku") == "outfit"
    assert attire.facet_of("necktie") == "outfit"
    assert attire.facet_of("blue_eyes") == "look"
    assert attire.facet_of("blue eyes") == "look"  # spelling canonicalised
    assert attire.facet_of("adjusting_scarf") is None  # not worn, not a pose group
    assert attire.facet_of("pointy_ears") == "look"  # unlisted, named as a body part
    assert attire.facet_of("1girl") is None
    assert attire.facets() == {
        "serafuku": "outfit",
        "thighhighs": "outfit",
        "necktie": "outfit",
        "anklet": "outfit",
        "barefoot": "outfit",
        "blue_eyes": "look",
        "jewelry": "outfit",
        "strapless": "outfit",
    }


def test_facets_from_groups(tmp_path, monkeypatch):
    path = tmp_path / "tag_groups.json"
    path.write_text(
        json.dumps(
            {
                "tags": {
                    "sitting": {"category": "body", "group": "posture"},
                    "holding_umbrella": {
                        "category": "objects",
                        "group": "holding_tags",
                        "also": ["more/water"],
                    },
                    "night_sky": {
                        "category": "image_composition_and_style",
                        "group": "backgrounds",
                    },
                    "cowboy_shot": {
                        "category": "image_composition_and_style",
                        "group": "image_composition",
                    },
                    "rain": {
                        "category": "more",
                        "group": "theme",
                        "also": ["more/water"],
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(attire, "TAG_GROUPS_PATH", path)
    attire._load.cache_clear()
    try:
        assert attire.facet_of("sitting") == "pose"
        assert attire.facet_of("holding_umbrella") == "pose"  # primary group first
        assert attire.facet_of("night_sky") == "scene"
        assert attire.facet_of("cowboy_shot") == "framing"
        assert attire.facet_of("rain") == "scene"  # through its other place
    finally:
        attire._load.cache_clear()


def test_expressions_and_eye_states_are_not_identity():
    # Listed with eyes too, but an expression or a passing state.
    for tag in (
        "@_@",
        "constricted_pupils",
        "closed_eyes",
        "half-closed_eyes",
        "sparkling_eyes",
    ):
        assert not attire.is_identity(tag), tag
        assert attire.facet_of(tag) == "pose", tag
    # Even with no tag groups to go on.
    assert attire._facet("tearing_up", None) == "pose"
    assert not attire.is_identity("tearing_up")
    # What the eyes are like stays.
    for tag in ("red_eyes", "heart-shaped_pupils", "heterochromia"):
        assert attire.is_identity(tag), tag


def test_animal_traits_are_a_look():
    cats = ("creatures", "cats", ())
    assert attire._facet("cat_girl", cats) == "look"
    assert attire._facet("cat", cats) is None  # the animal itself
    assert attire._facet("tail", ("body", "body_parts", ("sex/sex_acts",))) == "look"
    # Unlisted kemonomimi.
    assert attire._facet("fox_girl", None) == "look"
    assert attire._facet("wolf_boy", None) == "look"
    assert attire._facet("magical_girl", None) is None
