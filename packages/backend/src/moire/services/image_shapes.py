"""Image shapes: the size presets the gallery's Size filter offers.

Each preset is an aspect ratio with the SDXL size it is usually generated at.
An image belongs to the preset nearest its own ratio (by log ratio, so 2:1
and 1:2 are equally far from square), not to an exact size: an upscaled
1152x1680 is still 2:3, like the 832x1216 it came from. The bands between
presets meet at the geometric mean of their neighbours' ratios, so every
image has exactly one shape.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import sqlalchemy as sa

from ..database import schema as t


@dataclass(frozen=True)
class Shape:
    name: str
    width: int
    height: int

    @property
    def ratio(self) -> float:
        return self.width / self.height

    @property
    def orientation(self) -> str:
        if self.width == self.height:
            return "square"
        return "landscape" if self.width > self.height else "portrait"


# Tallest first, so the list reads portrait, square, landscape.
SHAPES: tuple[Shape, ...] = tuple(
    sorted(
        (
            Shape("1:1", 1024, 1024),
            Shape("8:5", 1216, 768),
            Shape("4:3", 1152, 896),
            Shape("3:2", 1216, 832),
            Shape("7:5", 1176, 840),
            Shape("16:9", 1344, 768),
            Shape("21:9", 1536, 640),
            Shape("19:9", 1472, 704),
            Shape("3:4", 896, 1152),
            Shape("2:3", 832, 1216),
            Shape("5:7", 840, 1176),
            Shape("9:16", 768, 1344),
            Shape("9:21", 640, 1536),
            Shape("5:8", 768, 1216),
            Shape("9:19", 704, 1472),
        ),
        key=lambda s: s.ratio,
    )
)
BY_NAME = {s.name: s for s in SHAPES}


def _bands() -> dict[str, tuple[float, float]]:
    """Each shape's ratio band ``[lo, hi)``: the midpoints to its neighbours."""
    out: dict[str, tuple[float, float]] = {}
    for i, s in enumerate(SHAPES):
        lo = math.sqrt(SHAPES[i - 1].ratio * s.ratio) if i else 0.0
        hi = (
            math.sqrt(s.ratio * SHAPES[i + 1].ratio)
            if i + 1 < len(SHAPES)
            else math.inf
        )
        out[s.name] = (lo, hi)
    return out


BANDS = _bands()


def shape_of(width: int, height: int) -> str | None:
    """The preset an image of this size belongs to; None without a size."""
    if not width or not height:
        return None
    k = width / height
    for name, (lo, hi) in BANDS.items():
        if lo <= k < hi:
            return name
    return None


def where(names: list[str]):
    """SQL: the image's shape is one of ``names`` (OR: an image has one
    shape). Unknown names match nothing."""
    w, h = t.images.c.width, t.images.c.height
    conds = []
    for name in dict.fromkeys(names):
        band = BANDS.get(name)
        if band is None:
            continue
        lo, hi = band
        cond = [h > 0, w >= h * lo]
        if hi != math.inf:
            cond.append(w < h * hi)
        conds.append(sa.and_(*cond))
    return sa.or_(*conds) if conds else sa.false()
