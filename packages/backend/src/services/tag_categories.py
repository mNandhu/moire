"""Which tag names are characters, from the tagger's own word list.

The WD model ships ``selected_tags.csv`` with a category per name (0 general,
4 character, 9 rating). A prompt tag spelled like a listed character
(``hu_tao_(genshin_impact)``) is a character too, whoever found it. Without a
downloaded model there is no list and every tag reads as general.

Prompts often drop the series: ``furina`` for ``furina_(genshin_impact)``.
Such a bare name is only a *candidate*, since many are ordinary words or
phrases too (``sunny`` is ``sunny_(omori)``, ``white_rabbit`` a character
as well as a rabbit). It needs exactly one listed character going by it, no
tag of its own, and the library's backing: most of its images also carrying
the series tag or the full name (``furina`` beside ``genshin_impact``). That
check needs the library, so :mod:`services.tag_index` makes it
(:func:`confirmed`).

The list is read once per file (keyed by path and mtime), so a model download
or switch is picked up without a restart.
"""

from __future__ import annotations

import asyncio
import csv
import os
import re
from dataclasses import dataclass, field

from ..core.config import settings as app_settings
from . import ai_settings
from .ai_tagger_download import labels_csv_path, model_target

CHARACTER = 4
# The share of a candidate's images that must carry its series or full name.
SERIES_SHARE = 0.5

# One trailing qualifier only: ``name_(series)``, not outfit variants.
_QUALIFIER = re.compile(r"^([^()]+)_\(([^()]+)\)$")


@dataclass(frozen=True)
class Candidate:
    """A bare name's listed character: what backs it on an image."""

    series: str  # ``genshin_impact``
    full: str  # ``furina_(genshin_impact)``


@dataclass(frozen=True)
class Vocab:
    """Lowercased listed character names, and bare names (``furina``)
    awaiting the library check."""

    names: frozenset[str] = frozenset()
    candidates: dict[str, Candidate] = field(default_factory=dict)


EMPTY = Vocab()

_cache: tuple[str, float, Vocab] | None = None


def _read(csv_path: str) -> Vocab:
    names: set[str] = set()
    others: set[str] = set()
    with open(csv_path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = (row.get("name") or "").strip().lower()
            if (row.get("category") or "").strip() == str(CHARACTER):
                names.add(name)
            else:
                others.add(name)
    names.discard("")
    return vocab(names, others)


def vocab(names: set[str], others: set[str]) -> Vocab:
    """The character vocabulary from the listed character names and every
    other listed tag. Pure."""
    by_bare: dict[str, list[Candidate]] = {}
    for name in names:
        if m := _QUALIFIER.match(name):
            by_bare.setdefault(m.group(1), []).append(Candidate(m.group(2), name))
    candidates = {
        bare: found[0]
        for bare, found in by_bare.items()
        if len(found) == 1 and bare not in others and bare not in names
    }
    return Vocab(frozenset(names), candidates)


def _load(csv_path: str) -> Vocab:
    global _cache
    try:
        mtime = os.path.getmtime(csv_path)
    except OSError:
        return EMPTY
    if _cache is not None and _cache[0] == csv_path and _cache[1] == mtime:
        return _cache[2]
    got = _read(csv_path)
    _cache = (csv_path, mtime, got)
    return got


async def load() -> Vocab:
    """The configured model's character vocabulary; empty without one."""
    repo, cache_dir = model_target(await ai_settings.get_ai_settings())
    if not repo:
        return EMPTY
    csv_path = labels_csv_path(
        model_repo=repo, cache_dir=str(app_settings.resolve_cache_dir(cache_dir))
    )
    return await asyncio.to_thread(_load, csv_path)


def confirmed(images: int, backed: int) -> bool:
    """Whether a candidate's library use backs it as a character: most of its
    images also carry its series tag or full name."""
    return images > 0 and backed / images >= SERIES_SHARE


def category(base: str, characters: frozenset[str]) -> str:
    return "character" if base.lower() in characters else "general"
