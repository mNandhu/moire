"""A one-sentence description of each of the WD tagger's general tags.

Shipped as ``data/tag_descriptions.json``, built offline by
``scripts/build_tag_descriptions.py``: each tag's Danbooru wiki lead condensed
by an LLM, or the tag described from its name where it has no wiki page, kept
only where the model knew the tag and was sure of it. Keys are lowercase tag
names (underscores); a tag without a description is simply absent.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("moire.tag_descriptions")

PATH = Path(__file__).resolve().parents[1] / "data" / "tag_descriptions.json"

_cache: dict[str, str] | None = None
# The last merge, keyed by the two maps it used: the tag list is read once
# per file, so a new download is a new alias map.
_merged: tuple[dict[str, str], dict[str, str], dict[str, str]] | None = None


def load() -> dict[str, str]:
    """``tag -> description``; empty when the file is missing or unreadable.
    Read once; a failed read isn't kept, so a later call tries again."""
    global _cache
    if _cache is None:
        try:
            with open(PATH, encoding="utf-8") as f:
                _cache = dict(json.load(f)["descriptions"])
        except (OSError, ValueError, KeyError) as exc:
            logger.warning("tag descriptions unavailable: %s", exc)
            return {}
    return _cache


def served(aliases: dict[str, str]) -> dict[str, str]:
    """:func:`with_aliases` over the shipped file, kept until the list changes."""
    global _merged
    descriptions = load()
    if _merged is None or _merged[0] is not descriptions or _merged[1] is not aliases:
        _merged = (descriptions, aliases, with_aliases(descriptions, aliases))
    return _merged[2]


def with_aliases(
    descriptions: dict[str, str], aliases: dict[str, str]
) -> dict[str, str]:
    """The descriptions, plus each Danbooru alias of a described tag under
    the alias's own name (``eyes_closed`` reads ``closed_eyes``'s)."""
    extra = {
        alias: descriptions[tag]
        for alias, tag in aliases.items()
        if tag in descriptions and alias not in descriptions
    }
    return {**extra, **descriptions}


def reset_for_tests() -> None:
    global _cache, _merged
    _cache = None
    _merged = None
