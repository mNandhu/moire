from src.services.generation_compose import auto_name, compose


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
