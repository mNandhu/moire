"""How long AI tagging takes here: seconds an image, for the time estimates.

Only the rate a real run measured on this machine: until one has, no rate,
since a typical device's can be well off. Measured rates are kept per device
and model, so neither switching to the GPU build nor to a heavier model
quotes the old one's.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from .. import app_settings
from .tagger import get_tagger_manager

logger = logging.getLogger("moire.ai_estimate")

# The app_settings row holding the measured rates, keyed "device|model repo".
# A key of the device alone is from before rates were kept per model, of no
# known model: never read, and dropped by the next record.
ROW = "ai_rate"
# A run is blended into the stored rate by its images; the stored rate weighs
# at most this many, so a later long run still moves it and a short one
# barely does.
MAX_WEIGHT = 1000
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
    rate = (rates.get(_key(device, model)) or {}).get("rate")
    return rate if rate and rate > 0 else None


def blend(stored: dict[str, Any] | None, rate: float, images: int) -> dict[str, Any]:
    """The stored entry with a run of ``images`` at ``rate`` blended in, by
    time an image, each weighted by its images (the stored one's capped)."""
    old_rate = (stored or {}).get("rate")
    old_n = min(int((stored or {}).get("images") or 0), MAX_WEIGHT)
    if not old_rate or old_rate <= 0 or old_n <= 0:
        return {"rate": rate, "images": images, "at": time.time()}
    seconds = (old_n / old_rate + images / rate) / (old_n + images)
    return {"rate": 1 / seconds, "images": old_n + images, "at": time.time()}


async def record(device: str, model: str, rate: float, images: int) -> None:
    """Blend ``rate`` (images a second) into this device's with ``model``,
    if the run was long enough to mean something. Best-effort: an estimate
    is never worth failing a job over."""
    if images < MIN_IMAGES or not rate or rate <= 0:
        return
    global _rates
    try:
        doc = dict(await app_settings.read(ROW) or {})
        key = _key(device, model)
        doc[key] = blend(doc.get(key), rate, images)
        doc.pop(device, None)  # a rate of no known model
        await app_settings.write(ROW, doc)
        _rates = doc
    except Exception:
        logger.debug("Could not store the tagging rate", exc_info=True)


async def estimate(model: str) -> dict[str, Any] | None:
    """``device`` ("cpu" or "gpu") and ``seconds_per_image`` with ``model``
    as measured on this machine, None until a run has. None for the whole
    estimate when the stored rates can't be read: unknown, which the UI must
    not take for never measured (it would offer a timing run)."""
    global _rates
    device = current_device()
    if _rates is None:
        try:
            _rates = dict(await app_settings.read(ROW) or {})
        except Exception:
            logger.warning("Could not read the tagging rates", exc_info=True)
            return None
    rate = _stored_rate(_rates, device, model)
    return {"device": device, "seconds_per_image": 1 / rate if rate else None}
