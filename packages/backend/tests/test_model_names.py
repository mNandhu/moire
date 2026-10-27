from moire.services import gen_metadata
from moire.services.model_names import model_stem


def test_model_stem_is_the_one_file_name_rule():
    for raw, stem in [
        ("styles/flat_color_xl.safetensors", "flat_color_xl"),
        ("a\\b\\x.PT", "x"),
        ("v1.5_style", "v1.5_style"),
        (" plain.ckpt ", "plain"),
    ]:
        assert model_stem(raw) == stem
        assert gen_metadata.lora_name(raw) == stem
