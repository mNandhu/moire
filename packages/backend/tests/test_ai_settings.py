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


def test_thresholds_clamped_and_mcut_coerced():
    out = clean_settings_patch(
        {"general_thresh": 35, "character_thresh": -1, "general_mcut": 1}
    )
    assert out == {"general_thresh": 1.0, "character_thresh": 0.0, "general_mcut": True}


def test_tag_params_defaults_are_the_settings_defaults():
    from dataclasses import asdict

    from moire.services.ai_settings import DEFAULT_AI_SETTINGS
    from moire.services.ai_tagger import TagParams

    assert asdict(TagParams()) == {
        k: DEFAULT_AI_SETTINGS[k] for k in asdict(TagParams())
    }
    assert TagParams.from_settings({}) == TagParams()
    assert TagParams.from_settings(DEFAULT_AI_SETTINGS) == TagParams()


def test_settings_patch_model_covers_every_setting():
    from moire.api.ai import SettingsPatch
    from moire.services.ai_settings import DEFAULT_AI_SETTINGS

    assert set(SettingsPatch.model_fields) == set(DEFAULT_AI_SETTINGS)
    assert SettingsPatch().model_dump(exclude_none=True) == {}
