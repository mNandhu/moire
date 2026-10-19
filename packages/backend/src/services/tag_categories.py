"""Which tag names are characters, from the tagger's own word list.

The WD model ships ``selected_tags.csv`` with a category per name (0 general,
4 character, 9 rating). A prompt tag spelled like a listed character
(``hu_tao_(genshin_impact)``) is a character too, whoever found it. Without a
downloaded model there is no list and every tag reads as general.

The list is read once per file (keyed by path and mtime), so a model download
or switch is picked up without a restart.
"""

from __future__ import annotations

import asyncio
import csv
import os

from ..core.config import settings as app_settings
from . import ai_settings
from .ai_tagger_download import labels_csv_path, model_target

CHARACTER = 4

_cache: tuple[str, float, frozenset[str]] | None = None


def _read(csv_path: str) -> frozenset[str]:
    names: set[str] = set()
    with open(csv_path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("category") or "").strip() == str(CHARACTER):
                names.add((row.get("name") or "").strip().lower())
    names.discard("")
    return frozenset(names)


def _load(csv_path: str) -> frozenset[str]:
    global _cache
    try:
        mtime = os.path.getmtime(csv_path)
    except OSError:
        return frozenset()
    if _cache is not None and _cache[0] == csv_path and _cache[1] == mtime:
        return _cache[2]
    names = _read(csv_path)
    _cache = (csv_path, mtime, names)
    return names


async def character_names() -> frozenset[str]:
    """Lowercased character names of the configured model; empty without one."""
    repo, cache_dir = model_target(await ai_settings.get_ai_settings())
    if not repo:
        return frozenset()
    csv_path = labels_csv_path(
        model_repo=repo, cache_dir=str(app_settings.resolve_cache_dir(cache_dir))
    )
    return await asyncio.to_thread(_load, csv_path)


def category(base: str, characters: frozenset[str]) -> str:
    return "character" if base.lower() in characters else "general"
