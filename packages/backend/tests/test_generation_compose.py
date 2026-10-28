from moire.services.generation_compose import (
    auto_name,
    compose,
    compose_parts,
    prompt_terms,
)


def test_compose_base_then_blocks_escaped_and_deduped():
    assert (
        compose(
            "masterpiece, best quality,",
            ["hu_tao_(genshin_impact)"],
            ["1girl", "embedding:easynegative"],
            ["1girl"],
        )
        == "masterpiece, best quality, hu_tao_\\(genshin_impact\\), 1girl, embedding:easynegative"
    )


def test_compose_empty_base():
    assert compose("", ["a"], []) == "a"
    assert compose("  ") == ""


def test_auto_name_rules():
    assert auto_name(
        number=3,
        generator="Built-in",
        character="hu_tao_(genshin_impact)",
        outfit="Default",
    ) == ("hu tao (genshin impact), Default")
    assert auto_name(
        number=3,
        generator="Built-in",
        extra=["embedding:x", "red_dress", "night", "rain"],
    ) == ("Built-in, red dress, night")
    assert auto_name(number=3, generator="Built-in") == "Batch 3"


def test_compose_parts_keeps_text_raw_and_chips_escaped():
    got = compose_parts(
        [
            "masterpiece, best quality,",
            ["hu_tao_(genshin_impact)", "red_eyes"],
            "embedding:pos/aesthetic",
            "(smile:1.2), sitting on a swing, red_eyes",
            [],
        ]
    )
    assert got == (
        "masterpiece, best quality, hu_tao_\\(genshin_impact\\), red_eyes, "
        "embedding:pos/aesthetic, (smile:1.2), sitting on a swing, red_eyes"
    )


def test_prompt_terms_for_the_auto_name():
    assert prompt_terms(
        "(smile:1.2), embedding:x, <lora:a:1>, sitting_on_swing, garden"
    ) == [
        "smile",
        "sitting on swing",
    ]
    assert prompt_terms("") == []


def test_without_terms_keeps_the_rest_as_written():
    from moire.services.prompt_parse import without_terms
    from moire.services.tag_names import canonical_name

    text = (
        "masterpiece, hu tao \\(genshin impact\\), brown hair,\n(twintails:1.2), smile"
    )
    drop = {"hu_tao_(genshin_impact)", "brown_hair", "twintails"}
    assert without_terms(text, drop, canonical_name) == "masterpiece,\n smile"
    # A dropped last piece takes the separator before it.
    assert without_terms("a, b, c", {"c"}, canonical_name) == "a, b"
    # A group goes only when all of it goes.
    assert without_terms("(a, b:1.2), c", {"a"}, canonical_name) == "(a, b:1.2), c"
    assert without_terms("", {"a"}, canonical_name) == ""


def test_without_terms_trims_both_ends():
    from moire.services.prompt_parse import without_terms
    from moire.services.tag_names import canonical_name

    assert (
        without_terms("hatsune_miku, 1girl", {"hatsune_miku"}, canonical_name)
        == "1girl"
    )
    assert (
        without_terms("1girl, hatsune_miku,", {"hatsune_miku"}, canonical_name)
        == "1girl"
    )
    # Untouched text keeps its own ends.
    assert without_terms(" 1girl,", {"x"}, canonical_name) == " 1girl,"


def test_prompt_terms_keep_escaped_parens_and_kaomoji():
    # The qualifier's escaped parens belong to the name; the old regex stripped
    # the trailing one. Kaomoji underscores are part of the face.
    assert prompt_terms(r"hu_tao_\(genshin_impact\), (>_<:1.1), smile", limit=3) == [
        "hu tao (genshin impact)",
        ">_<",
        "smile",
    ]
    assert (
        auto_name(number=1, generator="G", extra=[">_<", "red_dress"])
        == "G, >_<, red dress"
    )


def test_compose_leaves_an_escaped_chip_escaped_once():
    # A chip already written escaped is sent as it is, not escaped twice.
    assert compose("", ["furina \\(genshin impact\\)"]) == "furina \\(genshin impact\\)"
