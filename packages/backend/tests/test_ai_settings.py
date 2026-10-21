"""Unit tests for the pure AI-settings validation/clamping rules."""

from moire.services.ai_settings import clean_settings_patch


def test_unknown_keys_dropped():
    assert clean_settings_patch({"bogus": 1, "max_general": 5}) == {"max_general": 5}


def test_numeric_clamping_and_coercion():
    out = clean_settings_patch(
        {
            "max_general": -3,
            "max_character": "7",
            "general_thresh": "0.4",
            "idle_unload_s": -10,
        }
    )
    assert out["max_general"] == 0  # clamped to >= 0
    assert out["max_character"] == 7  # coerced from str
    assert out["general_thresh"] == 0.4  # coerced to float
    assert out["idle_unload_s"] == 0  # clamped to >= 0


def test_invalid_idle_unload_is_dropped_not_raised():
    assert clean_settings_patch({"idle_unload_s": "not-a-number"}) == {}


def test_model_repo_is_stripped():
    assert clean_settings_patch({"model_repo": "  org/repo  "}) == {
        "model_repo": "org/repo"
    }
