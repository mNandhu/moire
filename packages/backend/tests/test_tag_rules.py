"""Merge and split rules applied to prompt terms (pure)."""

from moire.services.tag_rules import apply_rule_weights, apply_rules


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


def test_apply_rule_weights_follows_the_rules():
    rules = {"kitty": ["cat"], "outfit": ["shirt", "skirt"]}
    assert apply_rule_weights({"kitty": 1.2, "outfit": 0.9}, rules) == {
        "cat": 1.2,
        "shirt": 0.9,
        "skirt": 0.9,
    }
    # Two sources merging: the weight farthest from 1 wins.
    assert apply_rule_weights({"cat": 1.1, "kitty": 0.8}, rules) == {"cat": 0.8}
    assert apply_rule_weights({"a": 1.2}, {}) == {"a": 1.2}
