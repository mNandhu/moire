"""BlurHash: a compact (~30 char) string encoding a blurred preview of an
image. The frontend decodes it to a placeholder so the gallery shows a blurry
image instantly instead of a grey skeleton.

Pure encoder (no extra dependency): the algorithm is small and stable, and
keeping it in-tree lets us encode straight from the PIL image the scanner has
already decoded. Spec: https://github.com/woltapp/blurhash

`encode` is pure (numpy in, string out) so it's unit-testable without I/O;
`blurhash_for_image` is the thin PIL adapter used by the scanner.
"""

from __future__ import annotations

import math

import numpy as np

_B83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~"


def _b83(value: int, length: int) -> str:
    out = ""
    for i in range(1, length + 1):
        digit = (value // (83 ** (length - i))) % 83
        out += _B83[digit]
    return out


def _linear_to_srgb(v: float) -> int:
    x = max(0.0, min(1.0, v))
    if x <= 0.0031308:
        return int(x * 12.92 * 255 + 0.5)
    return int((1.055 * (x ** (1 / 2.4)) - 0.055) * 255 + 0.5)


def _sign_pow(v: float, exp: float) -> float:
    return math.copysign(abs(v) ** exp, v)


def encode(rgb: np.ndarray, components_x: int = 6, components_y: int = 4) -> str:
    """Encode an HxWx3 uint8 sRGB array to a BlurHash string.

    `components_x`/`components_y` are the number of basis functions per axis
    (1..9); 6x4 gives a noticeably more detailed preview than the 4x3 minimum
    at a still-tiny (~52 char) payload.
    """
    cx = max(1, min(9, components_x))
    cy = max(1, min(9, components_y))
    h, w, _ = rgb.shape

    # sRGB (0..255) -> linear, vectorised.
    s = rgb.astype(np.float64) / 255.0
    linear = np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)

    xs = np.arange(w)
    ys = np.arange(h)

    factors: list[np.ndarray] = []
    for y in range(cy):
        cos_y = np.cos(math.pi * y * ys / h)
        for x in range(cx):
            cos_x = np.cos(math.pi * x * xs / w)
            basis = np.outer(cos_y, cos_x)  # (h, w)
            norm = 1.0 if (x == 0 and y == 0) else 2.0
            # factor[c] = norm/(w*h) * sum(basis * linear[:,:,c])
            factor = (norm / (w * h)) * np.tensordot(
                basis, linear, axes=([0, 1], [0, 1])
            )
            factors.append(factor)  # shape (3,)

    dc = factors[0]
    ac = factors[1:]

    # DC component: linear -> sRGB, packed.
    dc_val = (
        (_linear_to_srgb(dc[0]) << 16)
        + (_linear_to_srgb(dc[1]) << 8)
        + _linear_to_srgb(dc[2])
    )

    if ac:
        actual_max = max(float(np.max(np.abs(f))) for f in ac)
        quant_max = int(max(0, min(82, math.floor(actual_max * 166 - 0.5))))
        maximum = (quant_max + 1) / 166.0
    else:
        quant_max = 0
        maximum = 1.0

    out = _b83((cx - 1) + (cy - 1) * 9, 1)
    out += _b83(quant_max, 1)
    out += _b83(dc_val, 4)
    for f in ac:
        r = int(max(0, min(18, math.floor(_sign_pow(f[0] / maximum, 0.5) * 9 + 9.5))))
        g = int(max(0, min(18, math.floor(_sign_pow(f[1] / maximum, 0.5) * 9 + 9.5))))
        b = int(max(0, min(18, math.floor(_sign_pow(f[2] / maximum, 0.5) * 9 + 9.5))))
        out += _b83(r * 19 * 19 + g * 19 + b, 2)
    return out


def blurhash_for_image(pil_img, max_dim: int = 64) -> str | None:
    """Encode a BlurHash from a PIL image. Downsamples first. BlurHash is
    low-frequency, so a small image gives the same result far cheaper.
    Returns None on any failure (best-effort, never blocks indexing).
    """
    try:
        img = pil_img.convert("RGB")
        img.thumbnail((max_dim, max_dim))
        arr = np.asarray(img, dtype=np.uint8)
        if arr.ndim != 3 or arr.shape[2] != 3:
            return None
        return encode(arr)
    except Exception:
        return None
