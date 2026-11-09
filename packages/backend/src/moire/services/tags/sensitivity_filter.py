"""The Global Sensitivity Filter: the highest level the app shows, or off.

One setting for the whole server (``app_settings`` row "sensitivity_filter"),
so every device and remote access gets it. Levels are the ones in
:mod:`services.tags.tag_sensitivity` (0 general .. 3 explicit). The filter is a
maximum of general, sensitive or questionable; showing everything is "off".

While it is on, an image is shown only when its level is known and within
the maximum (:mod:`services.images.image_visibility`), and a tag name only when its
own level is (:func:`allowed`). The value is kept in memory, since every
visibility clause reads it; :func:`load_sync` at startup.
"""

from __future__ import annotations

from typing import Any

from .. import app_settings
from . import tag_index, tag_sensitivity

_ROW = "sensitivity_filter"

# The maxima the filter can be set to; anything higher is off.
CHOICES = tag_sensitivity.LEVELS[:3]

_max: int | None = None


def _parse(doc: dict[str, Any] | None) -> int | None:
    name = (doc or {}).get("max_level")
    return tag_sensitivity.LEVEL_OF[name] if name in CHOICES else None


def max_level() -> int | None:
    """The highest level shown, or None when the filter is off."""
    return _max


def load_sync() -> None:
    global _max
    _max = _parse(app_settings.read_sync(_ROW))


def state() -> dict[str, Any]:
    return {"max_level": tag_sensitivity.level_name(_max)}


async def set_max_level(name: str | None) -> dict[str, Any]:
    """Set the maximum (a name from :data:`CHOICES`), or turn the filter off
    (None, or "explicit": everything shows)."""
    global _max
    if name is not None and name not in tag_sensitivity.LEVEL_OF:
        raise ValueError(f"unknown level {name!r}")
    doc = {"max_level": name if name in CHOICES else None}
    await app_settings.write(_ROW, doc)
    _max = _parse(doc)
    # Every cached tag list and count was built for the old maximum.
    tag_index.invalidate()
    return state()


def allowed(tag: str) -> bool:
    """Whether a tag name may be shown: always while the filter is off, else
    when the tag's own level is within the maximum."""
    return _max is None or tag_sensitivity.level_of(tag) <= _max


def allowed_keys(by_tag: dict[str, Any]) -> dict[str, Any]:
    """``by_tag`` without the tags the filter hides (as is while it is off)."""
    if _max is None:
        return by_tag
    return {tag: v for tag, v in by_tag.items() if allowed(tag)}


def reset_for_tests() -> None:
    global _max
    _max = None
