"""Generation limits kept once. Pure. The frontend mirrors them in
``lib/generationLimits.ts`` (tests/test_mirrored_vocab.py keeps the two equal);
the API's field bounds, the remix check, the queue and the settings clamp all
read them from here."""

from __future__ import annotations

STEPS_RANGE = (1, 200)
CFG_RANGE = (0, 30)
# As many characters as one prompt takes (the composer's cap).
MAX_CHARACTERS = 8
# ComfyUI's seed widgets take an unsigned 64-bit value; stay well inside it.
SEED_MAX = 2**50
# The most images ComfyUI makes at once in one request.
PER_REQUEST_MAX = 64


def clamp_per_request(n: int) -> int:
    return max(1, min(PER_REQUEST_MAX, n))
