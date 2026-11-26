"""How long AI tagging takes here: seconds an image, for the time estimates.

The rate a real run measured on this machine wins; until one has, the
documented rates for the device the tagger runs on (docs/dev/perf-findings.md:
~0.6 images/s in a CPU job, ~0.1 s an image on a GTX 1650), which the UI
shows no time for. Measured rates are kept per device and model, so neither
switching to the GPU build nor to a heavier model quotes the old one's.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from .. import app_settings
from .settings import DEFAULT_AI_SETTINGS
from .tagger import get_tagger_manager

logger = logging.getLogger("moire.ai_estimate")

# The app_settings row holding the measured rates, keyed "device|model repo".
# A key of the device alone is from before rates were kept per model: taken
# as the default model's, the one nearly every such run used.
ROW = "ai_rate"
DEFAULT_SECONDS_PER_IMAGE = {"cpu": 1 / 0.6, "gpu": 0.1}
# A run shorter than this says more about warm-up than about the rate.
MIN_IMAGES = 20

# The stored rates, read once: /ai/status asks on every poll, and they only
# change when a run records one.
_rates: dict[str, Any] | None = None


def current_device() -> str:
    return get_tagger_manager().status().get("device") or "cpu"


def _key(device: str, model: str) -> str:
    return f"{device}|{model}"


def _stored_rate(rates: dict[str, Any], device: str, model: str) -> float | None:
    entry = rates.get(_key(device, model))
    if entry is None and model == DEFAULT_AI_SETTINGS["model_repo"]:
        entry = rates.get(device)
    rate = (entry or {}).get("rate")
    return rate if rate and rate > 0 else None


async def record(device: str, model: str, rate: float, images: int) -> None:
    """Keep ``rate`` (images a second) as this device's with ``model``, if
    the run was long enough to mean something. Best-effort: an estimate is
    never worth failing a job over."""
    if images < MIN_IMAGES or not rate or rate <= 0:
        return
    global _rates
    try:
        doc = dict(await app_settings.read(ROW) or {})
        doc[_key(device, model)] = {"rate": rate, "images": images, "at": time.time()}
        if model == DEFAULT_AI_SETTINGS["model_repo"]:
            doc.pop(device, None)  # the old key, now superseded
        await app_settings.write(ROW, doc)
        _rates = doc
    except Exception:
        logger.debug("Could not store the tagging rate", exc_info=True)


async def estimate(model: str) -> dict[str, Any]:
    """``device`` ("cpu" or "gpu"), ``seconds_per_image`` with ``model`` and
    whether that was ``measured`` on this machine or is the documented
    default."""
    global _rates
    device = current_device()
    if _rates is None:
        try:
            _rates = dict(await app_settings.read(ROW) or {})
        except Exception:
            return _default(device)
    rate = _stored_rate(_rates, device, model)
    if rate:
        return {"device": device, "seconds_per_image": 1 / rate, "measured": True}
    return _default(device)


def _default(device: str) -> dict[str, Any]:
    return {
        "device": device,
        "seconds_per_image": DEFAULT_SECONDS_PER_IMAGE[device],
        "measured": False,
    }
