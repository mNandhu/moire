"""Reprojection is total: a malformed graph still parses (the per-row skip
is in test_reproject_worker.py)."""

from moire.services.metadata import gen_metadata


def test_a_sampler_without_inputs_does_not_raise():
    g = gen_metadata.parse_comfyui({"3": {"class_type": "KSampler", "inputs": None}})
    assert g["source"] == "comfyui"


def test_a_checkpoint_without_inputs_does_not_raise():
    graph = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": None},
        "3": {"class_type": "KSampler", "inputs": {"seed": 1, "model": ["1", 0]}},
    }
    assert gen_metadata.parse_comfyui(graph)["model"] is None


def test_empty_gen_docs_share_no_lists():
    a, b = gen_metadata._empty(), gen_metadata._empty()
    for k, v in a.items():
        if isinstance(v, (list, dict)):
            assert v is not b[k], k
