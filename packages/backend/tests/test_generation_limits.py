"""The frontend's generation limits (lib/generationLimits.ts) must equal the
backend's, read from the TS source by path like tests/test_mirrored_vocab.py."""

import re
from pathlib import Path

from moire.services import generation_limits as limits

TS = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "lib"
    / "generationLimits.ts"
)


def _const(name: str) -> str:
    m = re.search(rf"export const {name} = (.+?);", TS.read_text(encoding="utf-8"))
    assert m, name
    return m.group(1)


def _range(name: str) -> tuple[int, int]:
    lo, hi = re.fullmatch(r"\[(\d+), (\d+)\] as const", _const(name)).groups()
    return int(lo), int(hi)


def test_ranges_match():
    assert _range("STEPS_RANGE") == limits.STEPS_RANGE
    assert _range("CFG_RANGE") == limits.CFG_RANGE


def test_scalars_match():
    assert int(_const("MAX_CHARACTERS")) == limits.MAX_CHARACTERS
    assert int(_const("PER_REQUEST_MAX")) == limits.PER_REQUEST_MAX
    base, exp = re.fullmatch(r"(\d+) \*\* (\d+)", _const("SEED_MAX")).groups()
    assert int(base) ** int(exp) == limits.SEED_MAX


def test_per_request_clamp():
    assert limits.clamp_per_request(0) == 1
    assert limits.clamp_per_request(999) == limits.PER_REQUEST_MAX
