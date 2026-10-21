"""BlurHash encoder invariants. We can't decode in-tree, so we assert the
wire format (length, charset, header) and that the DC term round-trips to the
image's average colour: that's what the frontend decoder reads first."""

import numpy as np

from moire.services import blurhash


def _b83_decode(s: str) -> int:
    val = 0
    for ch in s:
        val = val * 83 + blurhash._B83.index(ch)
    return val


def test_hash_length_and_charset_for_4x3():
    rgb = np.full((40, 60, 3), 128, dtype=np.uint8)
    h = blurhash.encode(rgb, 4, 3)
    # 1 (size) + 1 (max) + 4 (dc) + (4*3 - 1)*2 (ac) = 28
    assert len(h) == 28
    assert all(ch in blurhash._B83 for ch in h)


def test_size_flag_encodes_components():
    rgb = np.full((10, 10, 3), 100, dtype=np.uint8)
    h = blurhash.encode(rgb, 4, 3)
    size_flag = _b83_decode(h[0])
    assert size_flag % 9 + 1 == 4  # components_x
    assert size_flag // 9 + 1 == 3  # components_y


def test_dc_roundtrips_to_average_colour():
    # Solid colour -> DC term should decode back to ~that colour.
    rgb = np.zeros((32, 32, 3), dtype=np.uint8)
    rgb[:, :, 0] = 200  # R
    rgb[:, :, 1] = 100  # G
    rgb[:, :, 2] = 50  # B
    h = blurhash.encode(rgb, 4, 3)
    dc_val = _b83_decode(h[2:6])
    r = (dc_val >> 16) & 0xFF
    g = (dc_val >> 8) & 0xFF
    b = dc_val & 0xFF
    assert abs(r - 200) <= 2
    assert abs(g - 100) <= 2
    assert abs(b - 50) <= 2


def test_blurhash_for_image_handles_garbage():
    assert blurhash.blurhash_for_image(None) is None
