"""Pure tests for the canonical tag spelling."""

from moire.services import tag_names as tn


def test_canonical_name_joins_words_with_underscores():
    assert tn.canonical_name("  blue   eyes ") == "blue_eyes"
    assert tn.canonical_name("hu tao (genshin impact)") == "hu_tao_(genshin_impact)"


def test_canonical_name_is_idempotent_and_keeps_case():
    for raw in ("blue eyes", "Keeper Pick", "^_^", "a\tb", "x_x"):
        once = tn.canonical_name(raw)
        assert tn.canonical_name(once) == once
    assert tn.canonical_name("Keeper Pick") == "Keeper_Pick"


def test_canonical_name_leaves_lora_tokens_alone():
    assert tn.canonical_name("<lora:my style:0.8>") == "<lora:my style:0.8>"
