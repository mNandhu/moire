"""Merge and split rules applied to prompt terms (pure)."""

from moire.services.tag_rules import apply_rules


def test_apply_rules_maps_dedupes_and_sorts():
    out = apply_rules(["blonde", "blonde_hair", "smile"], {"blonde": ["blonde_hair"]})
    assert out == ["blonde_hair", "smile"]


def test_apply_rules_without_rules_is_identity():
    terms = ["b", "a"]
    assert apply_rules(terms, {}) is terms


def test_apply_rules_splits_one_term_into_several():
    out = apply_rules(
        ["long_white_hair", "long_hair", "smile"],
        {"long_white_hair": ["long_hair", "white_hair"]},
    )
    assert out == ["long_hair", "smile", "white_hair"]
