"""How long AI tagging takes here: seconds an image, for the time estimates.

The rate a real run measured on this machine wins; until one has, the
documented rates for the device the tagger runs on (docs/perf-findings.md:
~0.6 images/s in a CPU job, ~0.1 s an image on a GTX 1650). Measured rates
are kept per device, so switching to the GPU build doesn't quote the CPU's.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from . import app_settings
from .ai_tagger import get_tagger_manager

logger = logging.getLogger("moire.ai_estimate")

# The app_settings row holding the measured rates, by device.
ROW = "ai_rate"
DEFAULT_SECONDS_PER_IMAGE = {"cpu": 1 / 0.6, "gpu": 0.1}
# A run shorter than this says more about warm-up than about the rate.
MIN_IMAGES = 20

# The stored rates, read once: /ai/status asks on every poll, and they only
# change when a run records one.
_rates: dict[str, Any] | None = None


def current_device() -> str:
    return get_tagger_manager().status().get("device") or "cpu"


async def record(device: str, rate: float, images: int) -> None:
    """Keep ``rate`` (images a second) as this device's, if the run was long
    enough to mean something. Best-effort: an estimate is never worth failing
    a job over."""
    if images < MIN_IMAGES or not rate or rate <= 0:
        return
    global _rates
    try:
        doc = dict(await app_settings.read(ROW) or {})
        doc[device] = {"rate": rate, "images": images, "at": time.time()}
        await app_settings.write(ROW, doc)
        _rates = doc
    except Exception:
        logger.debug("Could not store the tagging rate", exc_info=True)


async def estimate() -> dict[str, Any]:
    """``device`` ("cpu" or "gpu"), ``seconds_per_image`` and whether that
    was ``measured`` on this machine or is the documented default."""
    global _rates
    device = current_device()
    if _rates is None:
        try:
            _rates = dict(await app_settings.read(ROW) or {})
        except Exception:
            return _default(device)
    rate = (_rates.get(device) or {}).get("rate")
    if rate and rate > 0:
        return {"device": device, "seconds_per_image": 1 / rate, "measured": True}
    return _default(device)


def _default(device: str) -> dict[str, Any]:
    return {
        "device": device,
        "seconds_per_image": DEFAULT_SECONDS_PER_IMAGE[device],
        "measured": False,
    }
