"""Unit tests for the Image tag-state invariant.

These exercise the pure helpers/transforms in ``services.image_tags``, the single
owner of the manual-prefix convention and the has_tags/has_ai_tags/has_prompt_tags
recompute, so the invariant has a test surface that needs no database. The
transactional repo writes are covered separately by the DB integration tests.
"""

from src.services import image_tags as it


# --- id candidates -----------------------------------------------------------


def test_id_candidates_primary_first_then_variants():
    # POSIX-spelled id tries itself, then the backslash variant.
    assert it.id_candidates("L1:a/b") == ["L1:a/b", "L1:a\\b"]


def test_id_candidates_no_separator_is_just_the_id():
    assert it.id_candidates("L1:plain") == ["L1:plain"]


def test_id_candidates_backslash_spelling():
    assert it.id_candidates("L1:a\\b") == ["L1:a\\b", "L1:a/b"]


# --- prefix helpers ----------------------------------------------------------


def test_to_manual_adds_prefix_idempotently():
    assert it.to_manual("cat") == "manual:cat"
    assert it.to_manual("manual:cat") == "manual:cat"


def test_is_manual():
    assert it.is_manual("manual:cat")
    assert not it.is_manual("cat")


def test_to_prompt_adds_prefix_idempotently():
    assert it.to_prompt("masterpiece") == "prompt:masterpiece"
    assert it.to_prompt("prompt:masterpiece") == "prompt:masterpiece"


def test_is_prompt():
    assert it.is_prompt("prompt:masterpiece")
    assert not it.is_prompt("masterpiece")
    assert not it.is_prompt("manual:fav")


def test_base_of_strips_kind_prefix():
    assert it.base_of("cat") == "cat"
    assert it.base_of("manual:cat") == "cat"
    assert it.base_of("prompt:cat") == "cat"


# --- any-source search sentinel ----------------------------------------------


def test_any_variants_fans_out_to_all_sources():
    assert it.any_variants("any:cat") == ["cat", "manual:cat", "prompt:cat"]


def test_expand_search_tag_exact_stays_precise():
    # Source-specific (deep-link) entries match only themselves.
    assert it.expand_search_tag("prompt:cat") == ["prompt:cat"]
    assert it.expand_search_tag("manual:cat") == ["manual:cat"]
    assert it.expand_search_tag("cat") == ["cat"]
    # any: fans out.
    assert it.expand_search_tag("any:cat") == ["cat", "manual:cat", "prompt:cat"]


# --- tag_match_groups: AND-of-EXISTS translation for SQL ----------------------


def test_tag_match_groups_single_any():
    # One group whose ids are the any: fan-out.
    assert it.tag_match_groups(["any:cat"], "and") == [
        ["cat", "manual:cat", "prompt:cat"]
    ]


def test_tag_match_groups_single_exact():
    assert it.tag_match_groups(["prompt:cat"], "and") == [["prompt:cat"]]


def test_tag_match_groups_two_entries_and_logic():
    # AND across groups (one group per entry), OR within each group.
    assert it.tag_match_groups(["any:cat", "any:dog"], "and") == [
        ["cat", "manual:cat", "prompt:cat"],
        ["dog", "manual:dog", "prompt:dog"],
    ]


def test_tag_match_groups_mixed_exact_and_any():
    assert it.tag_match_groups(["any:cat", "prompt:dog"], "and") == [
        ["cat", "manual:cat", "prompt:cat"],
        ["prompt:dog"],
    ]


def test_tag_match_groups_or_logic_unions_into_one_group_deduped():
    # OR flattens every variant into one group; overlapping ids dedupe, order kept.
    assert it.tag_match_groups(["any:cat", "cat"], "or") == [
        ["cat", "manual:cat", "prompt:cat"]
    ]


def test_excluded_prefixes_per_kind():
    # AI-only default excludes both prefixes.
    assert it.excluded_prefixes(include_manual=False, include_prompt=False) == [
        "manual:",
        "prompt:",
    ]
    assert it.excluded_prefixes(include_manual=True, include_prompt=False) == [
        "prompt:"
    ]
    assert it.excluded_prefixes(include_manual=False, include_prompt=True) == [
        "manual:"
    ]
    assert it.excluded_prefixes(include_manual=True, include_prompt=True) == []


# --- flag recompute ----------------------------------------------------------


def test_recompute_flags_axes():
    # AI tag: all three? has_tags + has_ai_tags, not prompt.
    assert it.recompute_flags(["1girl"]) == {
        "has_tags": True,
        "has_ai_tags": True,
        "has_prompt_tags": False,
    }
    # Manual only: curatable but not AI.
    assert it.recompute_flags(["manual:fav"]) == {
        "has_tags": True,
        "has_ai_tags": False,
        "has_prompt_tags": False,
    }
    # Prompt only: NOT curatable (stays in Untagged tile), not AI.
    assert it.recompute_flags(["prompt:masterpiece"]) == {
        "has_tags": False,
        "has_ai_tags": False,
        "has_prompt_tags": True,
    }
    assert it.recompute_flags([]) == {
        "has_tags": False,
        "has_ai_tags": False,
        "has_prompt_tags": False,
    }


# --- pure tag-set transforms (replace the old Mongo pipelines) ----------------


def test_union_tags_appends_new_preserves_order_dedupes():
    assert it.union_tags(["a", "b"], ["b", "manual:fav"]) == ["a", "b", "manual:fav"]


def test_without_tags_exact_match():
    assert it.without_tags(["cat", "manual:fav", "dog"], ["cat", "manual:fav"]) == [
        "dog"
    ]


def test_with_replaced_ai_keeps_manual_and_prompt():
    existing = ["old_ai", "manual:fav", "prompt:masterpiece"]
    assert it.with_replaced_ai(existing, ["1girl", "solo"]) == [
        "manual:fav",
        "prompt:masterpiece",
        "1girl",
        "solo",
    ]


def test_with_replaced_prompt_keeps_ai_and_manual():
    existing = ["1girl", "manual:fav", "prompt:old"]
    assert it.with_replaced_prompt(existing, ["prompt:new1", "prompt:new2"]) == [
        "1girl",
        "manual:fav",
        "prompt:new1",
        "prompt:new2",
    ]


def test_with_cleared_ai_keeps_non_ai():
    assert it.with_cleared_ai(["1girl", "solo", "manual:fav", "prompt:x"]) == [
        "manual:fav",
        "prompt:x",
    ]


def test_tag_rows_dedupes_and_sets_base():
    rows = it._tag_rows("img1", ["cat", "cat", "manual:fav", "prompt:m"])
    assert rows == [
        {"image_id": "img1", "tag": "cat", "base": "cat"},
        {"image_id": "img1", "tag": "manual:fav", "base": "fav"},
        {"image_id": "img1", "tag": "prompt:m", "base": "m"},
    ]


# --- rating normalization ----------------------------------------------------


def test_normalize_rating_canonical_and_aliases():
    assert it.normalize_rating("") == "-"
    assert it.normalize_rating(None) == "-"
    assert it.normalize_rating("none") == "-"
    assert it.normalize_rating("safe") == "general"
    assert it.normalize_rating("General") == "general"
    assert it.normalize_rating("EXPLICIT") == "explicit"
    assert it.normalize_rating("questionable") == "questionable"


def test_normalize_rating_unknown_is_none():
    assert it.normalize_rating("spicy") is None


# --- id variants -------------------------------------------------------------


def test_id_variants_swaps_separators():
    assert it.id_variants("lib:a/b") == ["lib:a\\b"]
    assert it.id_variants("lib:a\\b") == ["lib:a/b"]


def test_id_variants_excludes_primary_when_no_separator():
    assert it.id_variants("lib:flat") == []


# --- bulk manual edit --------------------------------------------------------


def test_with_manual_edit_prefixes_and_keeps_order():
    out = it.with_manual_edit(
        ["1girl", "manual:old", "prompt:x"], add=["keeper"], remove=["old"]
    )
    assert out == ["1girl", "prompt:x", "manual:keeper"]


def test_with_manual_edit_name_in_both_lists_ends_present():
    assert it.with_manual_edit(["manual:a"], add=["a"], remove=["a"]) == ["manual:a"]


def test_with_manual_edit_leaves_ai_and_prompt_alone():
    assert it.with_manual_edit(["cat", "prompt:cat"], add=[], remove=["cat"]) == [
        "cat",
        "prompt:cat",
    ]
