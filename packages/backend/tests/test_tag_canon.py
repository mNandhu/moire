"""Pure tests for the Danbooru-backed merge suggestions (services/tag_canon.py)."""

from moire.services.danbooru_tags import parse
from moire.services.tag_canon import MIN_POSTS, Resolver, suggest_all

P = MIN_POSTS
LIST = parse(
    f"""long_hair,0,{P},
white_hair,0,{P},"silver_white_hair"
grey_hair,0,{P},gray_hair
red_hair,0,{P},
heart_pasties,0,{P},
pasties,0,{P},
rose,0,{P},
red_rose,0,{P},
blue_suit,0,{P},
suit,0,{P},
sweater,0,{P},
red_sweater,0,{P},
turtleneck_sweater,0,{P},
everyone,0,{P},group
bodysuit,0,{P},body_suit
nidy,1,{P},2d
male_focus,0,{P},male
thighhighs,0,{P},stockings
fishnet_thighhighs,0,{P},
red_eyes,0,{P},
black_eyes,0,{P},dark_eyes
plugsuit_(evangelion),0,{P},plugsuit
forest,0,{P},
rare_thing,0,3,
""".splitlines()
)


def _s(name):
    s = Resolver(LIST).suggest(name)
    return (s.to, s.kind) if s else None


def test_tags_and_odd_names_are_left_alone():
    assert _s("long_hair") is None
    assert _s("nidy") is None
    assert _s("<lora:x:0.5>") is None
    assert _s("artist:someone") is None
    assert _s("sparkles") is None


def test_alias_reads_as_its_tag_but_not_an_artist():
    assert _s("body_suit") == (("bodysuit",), "alias")
    assert _s("2d") is None


def test_respell_singular_join_and_colour_synonym():
    assert _s("red_roses") == (("red_rose",), "respell")
    assert _s("silver_hair") == (("grey_hair",), "respell")
    # A respelling must be a tag itself, not an alias of another word.
    assert _s("groups") is None


def test_colour_plus_thing_as_one_tag():
    assert _s("dark_blue_suit") == (("blue_suit",), "colour")


def test_split_into_a_tag_per_describing_word():
    assert _s("long_white_hair") == (("long_hair", "white_hair"), "split")
    assert _s("red_turtleneck_sweater") == (
        ("red_sweater", "turtleneck_sweater"),
        "split",
    )
    # A part that is a kind of the thing already says it.
    assert _s("fishnet_stockings") == (("fishnet_thighhighs",), "respell")
    # A tone alone is not a tag.
    assert _s("dark_red_eyes") is None


def test_strip_the_colour_when_nothing_keeps_it():
    assert _s("black_heart_pasties") == (("heart_pasties",), "strip")
    assert _s("green_forest") == (("forest",), "strip")
    # Not a person, not a narrower qualified tag, not a rare tag.
    assert _s("black_male") is None
    assert _s("red_plugsuit") is None
    assert _s("blue_rare_thing") is None


def test_suggest_all_without_a_list_is_empty():
    assert suggest_all(["long_white_hair"], parse([])) == []
    assert [s.name for s in suggest_all(["x", "long_white_hair"], LIST)] == [
        "long_white_hair"
    ]
