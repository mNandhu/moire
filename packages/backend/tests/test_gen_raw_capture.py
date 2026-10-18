"""Raw generation-metadata capture: which embedded source wins, and how the
EXIF UserComment charset prefixes decode.

This is the branch coverage that was unreachable while the capture lived inside
the scanner's thumbnail renderer. The A1111 JPEG/WebP path in particular, the
container every A1111 export that isn't a PNG uses, had never executed in any
test, because exercising it meant synthesizing a real JPEG with EXIF and running
a full disk scan. Taking the two embedded sources as plain values makes each
branch a table test.
"""

from __future__ import annotations

import io
import json

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from src.services import gen_metadata

_COMFY = {
    "3": {"class_type": "KSampler", "inputs": {"positive": ["6", 0]}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a fox"}},
}
_A1111 = "a prompt\nSteps: 20, Seed: 7"


# --- UserComment decoding (pure) ----------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        (b"UNICODE\x00" + "Steps: 20".encode("utf-16-be"), "Steps: 20"),
        (b"ASCII\x00\x00\x00Steps: 20", "Steps: 20"),
        (b"Steps: 20", "Steps: 20"),  # bare payload, no charset prefix
        ("Steps: 20", "Steps: 20"),  # already decoded by the imaging library
        (None, ""),
        (b"", ""),
        (12345, ""),  # EXIF values are not always bytes
    ],
)
def test_decode_user_comment(raw, expected):
    assert gen_metadata.decode_user_comment(raw) == expected


def test_decode_user_comment_survives_a_truncated_utf16_payload():
    """`errors="ignore"` is load-bearing: a clipped surrogate must not raise
    mid-scan and abort the whole file."""
    raw = b"UNICODE\x00" + "Steps".encode("utf-16-be")[:-1]
    assert "Step" in gen_metadata.decode_user_comment(raw)


# --- Which embedded source wins (pure) ----------------------------------------


def test_comfyui_chunks_win_and_are_parsed():
    raw = gen_metadata.gen_raw_from_embedded(
        {"prompt": json.dumps(_COMFY), "workflow": json.dumps({"nodes": []})}
    )
    assert raw == {"source": "comfyui", "prompt": _COMFY, "workflow": {"nodes": []}}


def test_a_malformed_prompt_chunk_does_not_discard_an_intact_workflow():
    raw = gen_metadata.gen_raw_from_embedded(
        {"prompt": "{not json", "workflow": json.dumps({"nodes": []})}
    )
    assert raw["source"] == "comfyui"
    assert raw["prompt"] is None
    assert raw["workflow"] == {"nodes": []}  # survived its neighbour


def test_a1111_png_parameters_chunk():
    assert gen_metadata.gen_raw_from_embedded({"parameters": _A1111}) == {
        "source": "a1111",
        "parameters": _A1111,
    }


def test_blank_parameters_chunk_is_not_a1111():
    assert gen_metadata.gen_raw_from_embedded({"parameters": "   "}) is None


def test_a1111_from_exif_user_comment():
    """The JPEG/WebP path: no PNG text chunk exists, the payload is EXIF."""
    uc = b"UNICODE\x00" + _A1111.encode("utf-16-be")
    assert gen_metadata.gen_raw_from_embedded({}, uc) == {
        "source": "a1111",
        "parameters": _A1111,
    }


def test_user_comment_without_the_steps_marker_is_ignored():
    """A camera or editor comment is not generation data."""
    uc = b"ASCII\x00\x00\x00Shot on a phone"
    assert gen_metadata.gen_raw_from_embedded({}, uc) is None


def test_png_chunks_take_precedence_over_exif():
    uc = b"ASCII\x00\x00\x00Steps: 99, Seed: 1"
    raw = gen_metadata.gen_raw_from_embedded({"parameters": _A1111}, uc)
    assert raw["parameters"] == _A1111


def test_nothing_embedded_is_none():
    assert gen_metadata.gen_raw_from_embedded({}) is None
    assert gen_metadata.gen_raw_from_embedded(None) is None


# --- The PIL adapter ----------------------------------------------------------


def _png_with(**text_chunks: str) -> Image.Image:
    meta = PngInfo()
    for k, v in text_chunks.items():
        meta.add_text(k, v)
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "PNG", pnginfo=meta)
    buf.seek(0)
    return Image.open(buf)


def _jpeg_with_user_comment(payload: bytes) -> Image.Image:
    im = Image.new("RGB", (8, 8))
    exif = im.getexif()
    exif[0x9286] = payload
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif.tobytes())
    buf.seek(0)
    return Image.open(buf)


def test_read_gen_raw_pulls_png_text_chunks():
    with _png_with(parameters=_A1111) as im:
        assert gen_metadata.read_gen_raw(im) == {
            "source": "a1111",
            "parameters": _A1111,
        }


def test_read_gen_raw_pulls_exif_from_a_real_jpeg():
    """End to end through PIL on an actual JPEG, not just the pure branch."""
    with _jpeg_with_user_comment(b"UNICODE\x00" + _A1111.encode("utf-16-be")) as im:
        assert gen_metadata.read_gen_raw(im) == {
            "source": "a1111",
            "parameters": _A1111,
        }


def test_read_gen_raw_is_none_for_a_bare_image():
    with _png_with() as im:
        assert gen_metadata.read_gen_raw(im) is None


def test_read_gen_raw_tolerates_an_object_with_no_exif():
    class NoExif:
        info = {"parameters": _A1111}

        def getexif(self):
            raise OSError("no exif block")

    assert gen_metadata.read_gen_raw(NoExif())["parameters"] == _A1111
