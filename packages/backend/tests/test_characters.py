"""Character pages: colour from hair and eye tags, signature tags, a bare name
folded into its full one, and what the user sets."""

import pytest

from src.services import characters, tag_categories


def _chars(*names, **candidates):
    async def load():
        return tag_categories.Vocab(
            frozenset(names),
            {
                bare: tag_categories.Candidate(series, f"{bare}_({series})")
                for bare, series in candidates.items()
            },
        )

    return load


def test_colour_words_come_from_hair_and_eyes_only():
    assert characters.colour_of("large_innocent_green_eyes") == "green"
    assert characters.colour_of("light_blue_hair") == "light_blue"
    assert characters.colour_of("white_hair") == "white"
    assert characters.colour_of("multicolored_hair") is None
    assert characters.colour_of("hair_between_eyes") is None
    assert characters.colour_of("blue_dress") is None


def test_palette_prefers_a_real_colour_over_white_hair():
    # Nahida: white hair on every image, green eyes on most.
    rows = [(f"i{n}", "white_hair") for n in range(10)]
    rows += [(f"i{n}", "green_eyes") for n in range(6)]
    rows += [("i0", "large_innocent_green_eyes")]
    assert characters.palette(rows, 10) == ["hsl(130 50% 45%)"]


def test_palette_counts_images_not_tags_and_drops_rare_colours():
    # Arima Kana: red hair on one image of seven is no colour at all.
    assert characters.palette([("a", "red_hair"), ("a", "red_eyes")], 7) == []
    # Hu Tao: red eyes beat brown hair, which is dull.
    rows = [(i, "red_eyes") for i in "abcd"] + [(i, "brown_hair") for i in "abcd"]
    assert characters.palette(rows, 4)[0] == "hsl(355 70% 52%)"


def test_signature_tags_are_common_here_and_rare_elsewhere():
    counts = {"top_hat": 5, "1girl": 6, "gloves": 1, "genshin_impact": 6, "other": 3}
    library = {
        "top_hat": 5,
        "1girl": 90,
        "gloves": 20,
        "genshin_impact": 10,
        "other": 3,
    }
    got = characters.signature(
        counts, 6, library, 100, skip={"other"}, visual=frozenset()
    )
    assert [r["tag"] for r in got] == ["genshin_impact", "top_hat"]
    # with the tagger's list, only what can be seen
    seen = frozenset({"top_hat", "1girl", "gloves"})
    got = characters.signature(counts, 6, library, 100, skip=set(), visual=seen)
    assert [r["tag"] for r in got] == ["top_hat"]


def test_a_bare_name_joins_its_full_name_when_both_are_present():
    vocab = tag_categories.Vocab(
        frozenset({"furina_(genshin_impact)"}),
        {
            "furina": tag_categories.Candidate(
                "genshin_impact", "furina_(genshin_impact)"
            )
        },
    )
    got = characters.groups(["furina", "furina_(genshin_impact)", "nahida"], vocab)
    assert got == {
        "furina_(genshin_impact)": ["furina_(genshin_impact)", "furina"],
        "nahida": ["nahida"],
    }
    assert characters.groups(["furina"], vocab) == {"furina": ["furina"]}


def test_settings_are_checked():
    assert characters.clean({"name": " Furina ", "series": ""}) == {
        "name": "Furina",
        "series": None,
    }
    assert characters.clean({"color": "#3A7BD5"}) == {"color": "#3a7bd5"}
    for bad in ({"color": "blue"}, {"kind": "person"}, {"focus_x": 2}, {"nope": 1}):
        with pytest.raises(characters.CharacterError):
            characters.clean(bad)


async def test_page_folds_aliases_and_describes_the_character(
    client, seed, monkeypatch
):
    monkeypatch.setattr(
        tag_categories,
        "load",
        _chars("furina_(genshin_impact)", "nahida", furina="genshin_impact"),
    )
    look = ("blue_eyes", "top_hat", "white_hair")
    seed("L1:a", tags=("furina_(genshin_impact)", *look), score=4, rating="general")
    seed("L1:b", tags=("prompt:furina", "prompt:genshin_impact", *look))
    seed("L1:c", tags=("prompt:furina", "furina_(genshin_impact)", "nahida", *look))
    seed("L1:d", tags=("nahida", "green_eyes"))
    for i in range(6):
        seed(f"L1:x{i}", tags=("1girl",))

    got = (await client.get("/tags/character", params={"tag": "furina"})).json()
    assert got["tag"] == "furina_(genshin_impact)"
    assert got["aliases"] == ["furina"]
    assert got["count"] == 3
    assert got["palette"][0] == "hsl(215 70% 55%)"
    assert {"top_hat", "blue_eyes"} <= {s["tag"] for s in got["signature"]}
    assert got["with"] == [{"tag": "nahida", "count": 1}]
    assert [b["image_id"] for b in got["best"]] == ["L1:a"]
    assert got["scored"] == {"count": 1, "average": None}
    assert got["ratings"] == {"general": 1}
    assert got["thumb_url"]

    listed = {c["tag"]: c for c in (await client.get("/tags/characters")).json()}
    assert set(listed) == {"furina_(genshin_impact)", "nahida"}
    assert listed["furina_(genshin_impact)"]["aliases"] == ["furina"]
    assert listed["furina_(genshin_impact)"]["count"] == 3

    missing = await client.get("/tags/character", params={"tag": "nobody"})
    assert missing.status_code == 404


async def test_the_user_decides_what_is_a_character(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars("nahida"))
    seed("L1:a", tags=("prompt:my_oc", "nahida"))

    async def category(tag):
        rows = (await client.get("/tags/browse")).json()
        return next(r["category"] for r in rows if r["tag"] == tag)

    assert await category("my_oc") == "general"
    got = await client.patch(
        "/tags/character", params={"tag": "my_oc"}, json={"kind": "character"}
    )
    assert got.json()["kind"] == "character"
    assert await category("my_oc") == "character"

    await client.patch(
        "/tags/character", params={"tag": "nahida"}, json={"kind": "general"}
    )
    assert await category("nahida") == "general"
    await client.patch("/tags/character", params={"tag": "nahida"}, json={"kind": ""})
    assert await category("nahida") == "character"

    stored = await client.patch(
        "/tags/character",
        params={"tag": "my_oc"},
        json={"name": "Mira", "color": "#112233", "focus_x": 0.3, "focus_y": 0.2},
    )
    assert stored.json()["name"] == "Mira"
    page = (await client.get("/tags/character", params={"tag": "my_oc"})).json()
    assert (page["name"], page["color"], page["focus"]) == (
        "Mira",
        "#112233",
        [0.3, 0.2],
    )
    bad = await client.patch(
        "/tags/character", params={"tag": "my_oc"}, json={"color": "red"}
    )
    assert bad.status_code == 422


async def test_not_a_character_covers_every_name(client, seed, monkeypatch):
    monkeypatch.setattr(
        tag_categories,
        "load",
        _chars("nahida_(genshin_impact)", nahida="genshin_impact"),
    )
    seed("L1:a", tags=("nahida_(genshin_impact)", "prompt:nahida"))
    seed("L1:b", tags=("prompt:nahida", "prompt:genshin_impact"))
    await client.patch(
        "/tags/character",
        params={"tag": "nahida_(genshin_impact)"},
        json={"kind": "general"},
    )
    cats = {r["tag"]: r["category"] for r in (await client.get("/tags/browse")).json()}
    assert cats["nahida_(genshin_impact)"] == cats["nahida"] == "general"
    assert (await client.get("/tags/characters")).json() == []


async def test_an_avatar_pinned_under_an_alias_shows_everywhere(
    client, seed, monkeypatch
):
    monkeypatch.setattr(
        tag_categories,
        "load",
        _chars("furina_(genshin_impact)", furina="genshin_impact"),
    )
    seed("L1:a", tags=("furina_(genshin_impact)", "prompt:furina"))
    seed("L1:b", tags=("prompt:furina", "prompt:genshin_impact"))
    got = await client.post(
        "/tags/thumbnail/furina_(genshin_impact)", json={"image_id": "L1:b"}
    )
    assert got.status_code == 200
    page = (await client.get("/tags/character", params={"tag": "furina"})).json()
    listed = (await client.get("/tags/characters")).json()[0]
    assert page["thumb_url"] == listed["thumb_url"]
    assert listed["thumb_url"].endswith("/images/L1%3Ab/thumb")


async def test_any_name_edits_the_one_character(client, seed, monkeypatch):
    monkeypatch.setattr(
        tag_categories,
        "load",
        _chars("furina_(genshin_impact)", furina="genshin_impact"),
    )
    seed("L1:a", tags=("furina_(genshin_impact)", "prompt:furina"))
    seed("L1:b", tags=("prompt:furina", "prompt:genshin_impact"))
    stored = await client.patch(
        "/tags/character", params={"tag": "furina"}, json={"name": "Furina"}
    )
    assert stored.json()["tag"] == "furina_(genshin_impact)"
    # a pin through the bare name lands on the character too
    await client.post("/tags/thumbnail/furina", json={"image_id": "L1:b"})
    page = (await client.get("/tags/character", params={"tag": "furina"})).json()
    listed = (await client.get("/tags/characters")).json()[0]
    assert page["name"] == listed["name"] == "Furina"
    assert page["thumb_url"] == listed["thumb_url"]
    assert listed["thumb_url"].endswith("/images/L1%3Ab/thumb")
    await client.delete("/tags/thumbnail/furina")
    page = (await client.get("/tags/character", params={"tag": "furina"})).json()
    assert page["thumb_image_id"] is None


async def test_a_quarantined_avatar_falls_back_on_both_views(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars("frieren"))
    seed("L1:a", tags=("frieren",))
    seed("L1:b", tags=("frieren",))
    await client.post("/tags/thumbnail/frieren", json={"image_id": "L1:b"})
    await client.post("/images/L1:b/quarantine", json={"quarantined": True})
    page = (await client.get("/tags/character", params={"tag": "frieren"})).json()
    listed = (await client.get("/tags/characters")).json()[0]
    assert page["thumb_url"] == listed["thumb_url"]
    assert page["thumb_url"].endswith("/images/L1%3Aa/thumb")


async def test_renaming_carries_the_character_settings(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars())
    seed("L1:a", tags=("manual:mira",))
    await client.patch(
        "/tags/character",
        params={"tag": "mira"},
        json={"kind": "character", "color": "#112233"},
    )
    got = await client.post(
        "/tags/rename", json={"tag": "manual:mira", "to": "mira_oc"}
    )
    assert got.status_code == 200
    page = (await client.get("/tags/character", params={"tag": "mira_oc"})).json()
    assert (page["kind"], page["color"], page["category"]) == (
        "character",
        "#112233",
        "character",
    )


async def test_the_list_carries_each_characters_colour(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars("nahida", "furina"))
    for i in range(4):
        seed(f"L1:n{i}", tags=("nahida", "green_eyes", "white_hair"))
    seed("L1:f", tags=("furina", "blue_eyes"))
    # shared with Furina: her blue eyes don't colour Nahida
    seed("L1:both", tags=("nahida", "furina", "blue_eyes", "green_eyes"))
    listed = {c["tag"]: c for c in (await client.get("/tags/characters")).json()}
    page = (await client.get("/tags/character", params={"tag": "nahida"})).json()
    assert listed["nahida"]["color"] == page["palette"][0] == "hsl(130 50% 45%)"
    await client.patch(
        "/tags/character", params={"tag": "nahida"}, json={"color": "#00ff00"}
    )
    listed = {c["tag"]: c for c in (await client.get("/tags/characters")).json()}
    assert listed["nahida"]["color"] == "#00ff00"


def test_a_share_needs_enough_images_to_be_trusted():
    # 1 of 3 is a third, but could be chance; 2 of 3 is not.
    assert not characters.confident(1, 3)
    assert characters.confident(2, 3)
    assert not characters.confident(1, 2)
    assert characters.confident(2, 2)
    assert characters.confident(1, 1)  # a one-image character has only that
    assert not characters.confident(1, 5)
    assert characters.confident(2, 6)
    # with more images a third is enough
    assert characters.confident(4, 12)
    assert characters.confident(17, 50)
    assert not characters.confident(0, 5)
    assert not characters.confident(1, 0)


def test_signature_reads_solo_images_only_when_there_are_enough():
    assert characters.reads_solo(5, 3)
    assert not characters.reads_solo(5, 2)
    # 3 of 100 alone is too few to judge a look on
    assert not characters.reads_solo(100, 3)
    assert characters.reads_solo(100, 10)
    assert characters.reads_solo(10, 5)


def test_signature_drops_one_off_tags_on_few_images():
    # Arima Kana on three images: red eyes on all, a cap on one.
    counts = {"red_eyes": 3, "blonde_hair": 3, "beret": 1}
    library = {"red_eyes": 10, "blonde_hair": 10, "beret": 1}
    got = characters.signature(counts, 3, library, 1000, skip=set(), visual=frozenset())
    assert [r["tag"] for r in got] == ["blonde_hair", "red_eyes"]


def test_signature_keeps_one_colour_per_slot():
    counts = {"blonde_hair": 9, "brown_hair": 4, "red_eyes": 9, "blue_eyes": 4}
    library = dict.fromkeys(counts, 10)
    got = characters.signature(
        counts, 10, library, 1000, skip=set(), visual=frozenset()
    )
    assert [r["tag"] for r in got] == ["blonde_hair", "red_eyes"]


def test_a_multicolour_tag_makes_room_for_a_second_colour():
    found = [
        {"tag": "red_eyes", "count": 9},
        {"tag": "heterochromia", "count": 8},
        {"tag": "blue_eyes", "count": 8},
        {"tag": "green_eyes", "count": 4},
        {"tag": "white_hair", "count": 9},
        {"tag": "black_hair", "count": 5},
        {"tag": "long_hair", "count": 9},
    ]
    got = [r["tag"] for r in characters.one_colour_per_slot(found)]
    assert got == ["red_eyes", "heterochromia", "blue_eyes", "white_hair", "long_hair"]


async def test_signature_reads_solo_images_once_there_are_enough(
    client, seed, monkeypatch
):
    monkeypatch.setattr(tag_categories, "load", _chars("nahida", "furina"))
    for i in range(3):
        seed(f"L1:n{i}", tags=("nahida", "green_eyes", "white_hair"))
    # Shared with Furina twice: her top hat isn't Nahida's look.
    for i in range(2):
        seed(f"L1:both{i}", tags=("nahida", "furina", "top_hat", "green_eyes"))
    for i in range(20):
        seed(f"L1:x{i}", tags=("1girl",))
    page = (await client.get("/tags/character", params={"tag": "nahida"})).json()
    assert page["signature_images"] == 3
    assert "top_hat" not in {s["tag"] for s in page["signature"]}
    assert {"green_eyes", "white_hair"} <= {s["tag"] for s in page["signature"]}


async def test_page_look_is_how_they_are_drawn_and_dressed(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars("arima_kana"))
    # A beach set: the scene, the framing and the face are on every image.
    for i in range(7):
        seed(
            f"L1:k{i}",
            tags=(
                "arima_kana",
                "red_hair",
                "bikini",
                "cat_girl",
                "beach",
                "cowboy_shot",
                "@_@",
            ),
        )
    for i in range(30):
        seed(f"L1:x{i}", tags=("1girl",))
    page = (await client.get("/tags/character", params={"tag": "arima_kana"})).json()
    # A tag the groups don't place stays.
    assert {s["tag"] for s in page["signature"]} == {
        "red_hair",
        "bikini",
        "cat_girl",
    }


def test_gender_comes_from_the_count_tags():
    assert characters.gender({"1girl": 9, "solo": 8}, 10) == "girl"
    assert characters.gender({"1boy": 5, "1girl": 1}, 6) == "boy"
    assert characters.gender({"multiple_girls": 4, "1girl": 2}, 6) == "girl"
    assert characters.gender({"2girls": 4}, 6) == "girl"
    # always drawn with someone of the other kind: can't tell
    assert characters.gender({"1girl": 6, "1boy": 6}, 6) is None
    assert characters.gender({"1girl": 2}, 6) is None
    assert characters.gender({}, 0) is None
