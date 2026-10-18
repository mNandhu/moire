"""Unit tests for pure generation-metadata extraction: A1111 string parsing,
ComfyUI graph walking, signature stability across id renumbering, tokenisation,
and grouping."""

from src.services import gen_metadata as gm


# --- A1111 -------------------------------------------------------------------

A1111_FULL = (
    "a cyberpunk city, neon, masterpiece\n"
    "Negative prompt: blurry, lowres\n"
    "Steps: 30, Sampler: Euler a, CFG scale: 7.5, Seed: 12345, "
    "Size: 512x768, Model: realisticVision_v5"
)


def test_a1111_parses_all_fields():
    g = gm.parse_a1111(A1111_FULL)
    assert g["source"] == "a1111"
    assert g["prompt"] == "a cyberpunk city, neon, masterpiece"
    assert g["negative"] == "blurry, lowres"
    assert g["seed"] == 12345
    assert g["steps"] == 30
    assert g["cfg"] == 7.5
    assert g["sampler"] == "Euler a"
    assert g["model"] == "realisticVision_v5"


def test_a1111_without_negative():
    g = gm.parse_a1111("just a prompt\nSteps: 20, Seed: 1")
    assert g["prompt"] == "just a prompt"
    assert g["negative"] is None
    assert g["seed"] == 1


def test_a1111_empty_is_safe():
    g = gm.parse_a1111("")
    assert g["source"] == "a1111"
    assert g["prompt"] is None and g["seed"] is None


# --- ComfyUI -----------------------------------------------------------------

COMFY = {
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 999,
            "steps": 25,
            "cfg": 8.0,
            "sampler_name": "dpmpp_2m",
            "model": ["4", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "sdxl.safetensors"},
    },
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a fox in snow"}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "ugly, blurry"}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024}},
}


def test_comfyui_structural_extraction():
    g = gm.parse_comfyui(COMFY)
    assert g["source"] == "comfyui"
    assert g["prompt"] == "a fox in snow"
    assert g["negative"] == "ugly, blurry"
    assert g["seed"] == 999
    assert g["steps"] == 25
    assert g["cfg"] == 8.0
    assert g["sampler"] == "dpmpp_2m"
    assert g["model"] == "sdxl.safetensors"


def test_comfyui_positive_negative_disambiguated_by_edge_not_order():
    # Even though node 7 (negative) could be picked first by class, the edge from
    # the sampler's `positive` link must select node 6.
    g = gm.parse_comfyui(COMFY)
    assert g["prompt"] == "a fox in snow"


def test_comfyui_model_via_lora_passthrough():
    graph = dict(COMFY)
    graph["3"] = {**COMFY["3"], "inputs": {**COMFY["3"]["inputs"], "model": ["8", 0]}}
    graph["8"] = {
        "class_type": "LoraLoader",
        "inputs": {"lora_name": "x.safetensors", "model": ["4", 0]},
    }
    g = gm.parse_comfyui(graph)
    assert g["model"] == "sdxl.safetensors"


# --- Signature ---------------------------------------------------------------


def test_signature_stable_across_id_renumber():
    renumbered = {("4" + k if False else str(int(k) + 40)): v for k, v in COMFY.items()}
    assert gm.workflow_sig(COMFY) == gm.workflow_sig(renumbered)


def test_signature_stable_across_value_tweak():
    tweaked = dict(COMFY)
    tweaked["6"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "totally different"},
    }
    assert gm.workflow_sig(COMFY) == gm.workflow_sig(tweaked)


def test_signature_changes_on_node_kind_change():
    extra = dict(COMFY)
    extra["99"] = {"class_type": "UpscaleModelLoader", "inputs": {}}
    assert gm.workflow_sig(COMFY) != gm.workflow_sig(extra)


def test_signature_none_on_empty():
    assert gm.workflow_sig({}) is None
    assert gm.workflow_sig(None) is None


# --- Tokenise / group --------------------------------------------------------


def test_tokenize_splits_on_commas_lowercase_dedup():
    # Commas are the tag separator; multi-word tags keep their spaces.
    terms = gm.tokenize_prompt("Cyberpunk City, neon, NEON")
    assert terms == ["cyberpunk city", "neon"]


def test_tokenize_preserves_multiword_tag_with_escaped_parens():
    # The reported bug: "hu tao \\(genshin impact\\)" is ONE tag, not hu + tao.
    terms = gm.tokenize_prompt(r"1girl, hu tao \(genshin impact\), smile")
    assert terms == ["1girl", "hu tao (genshin impact)", "smile"]


def test_tokenize_preserves_lora_and_danbooru_tokens():
    terms = gm.tokenize_prompt("1girl, <lora:foo:0.8>")
    assert "1girl" in terms
    assert "<lora:foo:0.8>" in terms


def test_tokenize_strips_emphasis_brackets_and_weights():
    # (tag1:1.1,tag2) -> bracket + trailing :weight stripped
    assert gm.tokenize_prompt("(tag1:1.1,tag2)") == ["tag1", "tag2"]


def test_tokenize_drops_bare_weight_token():
    # (tag1,tag2,:1.1) -> the orphan :1.1 weight collapses to empty and is dropped
    assert gm.tokenize_prompt("(tag1,tag2,:1.1)") == ["tag1", "tag2"]


def test_tokenize_keeps_numeric_tags():
    # A weight strip must not eat legitimate numeric tags (year, danbooru counts).
    assert "1990" in gm.tokenize_prompt("1990, sunset")


def test_tokenize_preserves_balanced_danbooru_qualifier():
    # name_(series) qualifiers are the dominant wd-tagger tag shape: the closing
    # paren is part of the tag and must survive (regression guard).
    assert gm.tokenize_prompt("hatsune_miku_(vocaloid)") == ["hatsune_miku_(vocaloid)"]


def test_tokenize_peels_fully_wrapping_emphasis():
    # (masterpiece) and (masterpiece:1.2) emphasis both reduce to the bare tag.
    assert gm.tokenize_prompt("(masterpiece)") == ["masterpiece"]
    assert gm.tokenize_prompt("(masterpiece:1.2)") == ["masterpiece"]


def test_group_id_same_for_same_sig_and_prompt():
    a = gm.group_id("sigX", "same prompt")
    b = gm.group_id("sigX", "same prompt")
    assert a == b and a is not None


def test_group_id_none_without_prompt():
    assert gm.group_id("sigX", "") is None
    assert gm.group_id("sigX", None) is None


def test_group_id_differs_by_prompt():
    assert gm.group_id("sigX", "p1") != gm.group_id("sigX", "p2")


# --- Dispatcher --------------------------------------------------------------


def test_extract_comfyui_fills_derived_fields():
    g = gm.extract({"source": "comfyui", "prompt": COMFY})
    assert g["model"] == "sdxl.safetensors"
    assert g["workflow_sig"] is not None
    assert "a fox in snow" in g["prompt_terms"]
    assert g["group_id"] is not None


def test_extract_a1111():
    g = gm.extract({"source": "a1111", "parameters": A1111_FULL})
    assert g["seed"] == 12345
    assert "a cyberpunk city" in g["prompt_terms"]


def test_extract_unknown_source_returns_none():
    assert gm.extract({"source": "nope"}) is None


def test_extract_positive_only_default_excludes_negative_terms():
    # A1111_FULL negative is "blurry, lowres"; default (positive-only) drops them.
    g = gm.extract({"source": "a1111", "parameters": A1111_FULL})
    assert "a cyberpunk city" in g["prompt_terms"]
    assert "blurry" not in g["prompt_terms"]
    assert "lowres" not in g["prompt_terms"]


def test_extract_positive_only_false_includes_negative_terms():
    g = gm.extract(
        {"source": "a1111", "parameters": A1111_FULL}, prompt_positive_only=False
    )
    assert "a cyberpunk city" in g["prompt_terms"]
    assert "blurry" in g["prompt_terms"]
    assert gm.extract(None) is None


# --- Path resolver -----------------------------------------------------------

RAW_COMFY = {"source": "comfyui", "prompt": COMFY}


def test_resolve_path_dict_keys():
    assert gm.resolve_path(RAW_COMFY, "prompt.6.inputs.text") == "a fox in snow"


def test_resolve_path_list_index():
    assert gm.resolve_path(RAW_COMFY, "prompt.3.inputs.positive.0") == "6"


def test_resolve_path_missing_returns_none():
    assert gm.resolve_path(RAW_COMFY, "prompt.999.inputs.text") is None
    assert gm.resolve_path(RAW_COMFY, "prompt.6.inputs.text.deeper") is None


def test_resolve_path_bad_index_returns_none():
    assert gm.resolve_path(RAW_COMFY, "prompt.3.inputs.positive.99") is None
    assert gm.resolve_path(RAW_COMFY, "prompt.3.inputs.positive.x") is None


def test_resolve_path_empty_or_nonwalkable():
    assert gm.resolve_path(RAW_COMFY, "") is None
    assert gm.resolve_path(None, "a.b") is None


# --- Ruleset application -----------------------------------------------------


def test_pin_overrides_structural():
    rs = {
        "fields": {"prompt": ["prompt.7.inputs.text"]}
    }  # point prompt at the negative node
    g = gm.extract(RAW_COMFY, rs)
    assert g["prompt"] == "ugly, blurry"  # pin won
    assert g["negative"] == "ugly, blurry"  # structural untouched


def test_pin_null_leaves_structural_baseline():
    rs = {"fields": {"prompt": ["prompt.999.inputs.text"]}}  # resolves to None
    g = gm.extract(RAW_COMFY, rs)
    assert g["prompt"] == "a fox in snow"  # structural baseline intact


def test_first_non_null_pin_wins():
    rs = {"fields": {"prompt": ["prompt.999.inputs.text", "prompt.6.inputs.text"]}}
    assert gm.extract(RAW_COMFY, rs)["prompt"] == "a fox in snow"


def test_pin_on_link_or_dict_is_miss_falls_through():
    # `prompt.3.inputs.positive` is a link list ["6",0]; a str field rejects it.
    rs = {"fields": {"prompt": ["prompt.3.inputs.positive"]}}
    g = gm.extract(RAW_COMFY, rs)
    assert g["prompt"] == "a fox in snow"  # fell through to structural


def test_pinned_scalar_is_coerced_per_field():
    rs = {"fields": {"seed": ["prompt.3.inputs.steps"]}}  # steps is 25 (int already)
    g = gm.extract(RAW_COMFY, rs)
    assert g["seed"] == 25 and isinstance(g["seed"], int)


def test_empty_ruleset_behaves_like_none():
    assert gm.extract(RAW_COMFY, {"fields": {}}) == gm.extract(RAW_COMFY)
    assert gm.extract(RAW_COMFY, {}) == gm.extract(RAW_COMFY)


def test_unknown_rule_field_ignored():
    rs = {"fields": {"workflow_sig": ["prompt.6.inputs.text"], "bogus": ["x"]}}
    g = gm.extract(RAW_COMFY, rs)
    # workflow_sig stays the computed hash, not overridden by a pin
    assert g["workflow_sig"] == gm.workflow_sig(COMFY)


def test_resolve_ruleset_paths_reports_per_path():
    fields = {"prompt": ["prompt.6.inputs.text", "prompt.999.x"]}
    rows = gm.resolve_ruleset_paths(RAW_COMFY, fields)["prompt"]
    assert rows[0] == {
        "path": "prompt.6.inputs.text",
        "raw": "a fox in snow",
        "coerced": "a fox in snow",
    }
    assert rows[1] == {"path": "prompt.999.x", "raw": None, "coerced": None}


# --- Resilient JSON parsing (loads_lenient) ----------------------------------


def test_loads_lenient_valid_passes_through():
    assert gm.loads_lenient('{"a": 1, "b": [2, 3]}') == {"a": 1, "b": [2, 3]}


def test_loads_lenient_recovers_unescaped_control_char():
    # A real newline pasted into a text-encode widget — strict json.loads rejects.
    s = '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"line1\nmasterpiece"}}}'
    out = gm.loads_lenient(s)
    assert out["6"]["inputs"]["text"] == "line1\nmasterpiece"


def test_loads_lenient_recovers_trailing_bytes():
    # NUL padding / a concatenated blob after the document.
    s = '{"3":{"class_type":"KSampler"}}\x00\x00garbage'
    assert gm.loads_lenient(s) == {"3": {"class_type": "KSampler"}}


def test_loads_lenient_truncated_is_unrecoverable():
    assert gm.loads_lenient('{"3":{"inputs":{"seed":99') is None


def test_loads_lenient_empty_and_non_str():
    assert gm.loads_lenient("") is None
    assert gm.loads_lenient("   ") is None
    assert gm.loads_lenient(None) is None
    assert gm.loads_lenient(123) is None


# --- Non-finite-float sanitization (strict-JSON serialization guard) ---------


def test_sanitize_json_replaces_non_finite_with_none():
    nan = float("nan")
    inf = float("inf")
    src = {
        "prompt": {"34": {"is_changed": nan, "cfg": inf, "steps": 20}},
        "list": [1, nan, "ok"],
        "fine": 7.5,
    }
    out = gm.sanitize_json(src)
    assert out["prompt"]["34"]["is_changed"] is None
    assert out["prompt"]["34"]["cfg"] is None
    assert out["prompt"]["34"]["steps"] == 20
    assert out["list"] == [1, None, "ok"]
    assert out["fine"] == 7.5
    # Result must round-trip through strict JSON (what Starlette does).
    import json

    json.dumps(out, allow_nan=False)


def test_to_float_rejects_non_finite():
    # NaN/Infinity must never enter gen.* (they would 500 the feed on render).
    assert gm._to_float(float("nan")) is None
    assert gm._to_float(float("inf")) is None
    assert gm._to_float("NaN") is None
    assert gm._to_float(7.5) == 7.5


def test_to_int_rejects_non_finite():
    assert gm._to_int(float("nan")) is None
    assert gm._to_int(float("inf")) is None
    assert gm._to_int(20) == 20


def test_workflow_node_types_reads_class_types():
    graph = {
        "1": {"class_type": "KSampler"},
        "2": {"class_type": "LoraLoader"},
        "3": {"inputs": {}},
        "x": "not a node",
    }
    assert sorted(gm.workflow_node_types(graph)) == ["KSampler", "LoraLoader"]
    assert gm.workflow_node_types(None) == []


def test_describe_signatures_subtracts_shared_baseline():
    base = ["KSampler", "CLIPTextEncode", "CLIPTextEncode", "VAEDecode"]
    out = gm.describe_signatures(
        {
            "a": base,
            "b": base + ["LoraLoader", "LoraLoader", "FaceDetailer"],
        }
    )
    assert out["a"] == {"node_count": 4, "distinct": []}
    assert out["b"]["node_count"] == 7
    assert out["b"]["distinct"] == [
        {"type": "LoraLoader", "count": 2},
        {"type": "FaceDetailer", "count": 1},
    ]


def test_describe_signatures_prefers_rare_nodes_and_skips_ui_nodes():
    base = ["KSampler"]
    out = gm.describe_signatures(
        {
            "a": base + ["PreviewImage", "PreviewImage", "Upscale"],
            "b": base + ["Upscale", "FaceDetailer"],
            "c": base,
        }
    )
    # FaceDetailer is in one sig, Upscale in two: the rarer names it first.
    assert [d["type"] for d in out["b"]["distinct"]] == ["FaceDetailer", "Upscale"]
    assert [d["type"] for d in out["a"]["distinct"]] == ["Upscale"]


def test_describe_single_signature_lists_its_most_common_nodes():
    out = gm.describe_signatures({"a": ["A", "B", "B", "C"]}, limit=2)
    assert out["a"]["distinct"] == [
        {"type": "B", "count": 2},
        {"type": "A", "count": 1},
    ]
