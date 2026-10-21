"""Prompt board placement and Danbooru's tag list: pure parts, then the
/tags/place and /tags/board routes against a small list on disk."""

import pytest

from moire.services import danbooru_tags, prompt_board
from moire.services.danbooru_tags import TagList, newest, parse

LIST = [
    '1girl,0,8483124,"sole_female,1girls"',
    'long_hair,0,6263710,"/lh,longhair"',
    'fellatio,0,99573,"blow_job,blowjob"',
    'irrumatio,0,17154,"forced_blowjob"',
    "blue_sky,0,303405,",
    "hatsune_miku,4,146762,miku",
    "wlop,1,401,",
    "absurdres,5,3036805,",
    # Two tags claiming one alias, and an alias that is a tag itself.
    'a_tag,0,10,"shared,blue_sky"',
    "b_tag,0,10,shared",
    "broken,row",
]
TAGS = parse(LIST)


def place(name: str) -> dict:
    return prompt_board.place(name, TAGS, frozenset({"furina_(genshin_impact)"}))


def test_parse_keeps_clean_aliases_only():
    assert TAGS.aliases["blowjob"] == "fellatio"
    assert TAGS.aliases["longhair"] == "long_hair"
    assert "/lh" not in TAGS.aliases
    assert "shared" not in TAGS.aliases
    assert "blue_sky" not in TAGS.aliases
    assert "broken" not in TAGS.tags
    assert TAGS.tags["hatsune_miku"] == (4, 146762)


def test_newest_full_list():
    assert (
        newest(
            [
                "README.md",
                "danbooru_2026-04-01_pt20-ia-dd.csv",
                "danbooru_2026-10-01_pt20-ia-dd.csv",
                "danbooru_2026-12-01_pt25-ia-dd.csv",
            ]
        )
        == "danbooru_2026-10-01_pt20-ia-dd.csv"
    )
    assert newest(["README.md"]) is None


@pytest.mark.parametrize(
    "name,section",
    [
        ("1girl", "subject"),
        ("solo", "subject"),
        ("hatsune_miku", "subject"),
        ("furina_(genshin_impact)", "subject"),
        ("long_hair", "hair"),
        ("blue_eyes", "eyes"),
        ("looking_at_viewer", "eyes"),
        ("smile", "expression"),
        ("closed_eyes", "expression"),
        ("navel", "body"),
        ("straw_hat", "attire"),
        ("white_dress", "attire"),
        ("standing", "pose"),
        ("holding_flower", "pose"),
        ("cowboy_shot", "framing"),
        ("portrait", "framing"),
        ("outdoors", "background"),
        ("blue_sky", "background"),
        ("sunflower_field", "background"),
        ("sunlight", "lighting"),
        ("wlop", "style"),
        ("absurdres", "quality"),
        ("xyzzy_tag", "unknown"),
    ],
)
def test_sections(name, section):
    assert place(name)["section"] == section


def test_alias_placed_as_its_tag():
    p = place("Blowjob")
    assert p["alias_of"] == "fellatio"
    assert p["section"] == "pose"
    assert p["posts"] == 99573
    assert "alias_of" not in place("fellatio")


def test_nothing_unknown_without_the_list():
    assert prompt_board.place("xyzzy_tag", TagList(), frozenset())["section"] == "other"


def test_offers_rank_by_posts_and_skip_aliases_and_characters():
    offers = prompt_board.offers(
        ["blue_sky"], TAGS, frozenset(), ["my_lora_word", "hatsune_miku", "blowjob"]
    )
    assert ["blue_sky", 303405] in offers["background"]
    hair = [n for n, _ in offers["hair"]]
    assert hair.index("long_hair") < hair.index("short_hair")
    every = {n for v in offers.values() for n, _ in v}
    assert "my_lora_word" not in every  # unknown: not offered
    assert "hatsune_miku" not in every
    assert "blowjob" not in every


def test_offers_leave_stray_library_words_out_without_the_list():
    offers = prompt_board.offers(
        [], TagList(), frozenset(), ["my_lora_word", "red_kimono"]
    )
    every = {n for v in offers.values() for n, _ in v}
    assert "my_lora_word" not in every
    assert "red_kimono" in every
    assert "quality" not in offers


# -- Routes ---------------------------------------------------------------------


@pytest.fixture
def tag_list(tmp_path, monkeypatch):
    path = tmp_path / "danbooru-tags.csv"
    path.write_text("\n".join(LIST), encoding="utf-8")
    monkeypatch.setattr(danbooru_tags, "list_path", lambda: path)
    monkeypatch.setattr(danbooru_tags, "ensure_fresh", lambda: None)
    danbooru_tags.reset_for_tests()
    yield path
    danbooru_tags.reset_for_tests()


@pytest.mark.asyncio
async def test_place_route(client, tag_list):
    r = await client.post(
        "/tags/place", json={"names": ["blowjob", "xyzzy_tag", "long_hair"]}
    )
    body = r.json()
    assert body["list"] is True
    assert body["fetching"] is False
    assert body["names"]["blowjob"]["alias_of"] == "fellatio"
    assert body["names"]["xyzzy_tag"]["section"] == "unknown"
    assert body["names"]["long_hair"]["section"] == "hair"


@pytest.mark.asyncio
async def test_place_route_without_list(client, tmp_path, monkeypatch):
    monkeypatch.setattr(danbooru_tags, "list_path", lambda: tmp_path / "missing.csv")
    monkeypatch.setattr(danbooru_tags, "ensure_fresh", lambda: None)
    body = (await client.post("/tags/place", json={"names": ["xyzzy_tag"]})).json()
    assert body["list"] is False
    assert body["names"]["xyzzy_tag"]["section"] == "other"


@pytest.mark.asyncio
async def test_board_route_offers_library_tags(client, seed, tag_list):
    seed("L1:a", tags=("prompt:red_kimono",))
    offers = (await client.get("/tags/board")).json()
    assert "red_kimono" in {n for n, _ in offers["attire"]}
