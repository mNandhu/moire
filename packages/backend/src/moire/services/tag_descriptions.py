"""A one-sentence description of each of the WD tagger's general tags.

Shipped as ``data/tag_descriptions.json``, built offline by
``scripts/build_tag_descriptions.py``: each tag's Danbooru wiki lead condensed
by an LLM, or the tag described from its name where it has no wiki page, kept
only where the model knew the tag and was sure of it. Keys are lowercase tag
names (underscores); a tag without a description is simply absent.

A tag the groups file keeps by hash (:func:`hidden`: it has a sensitivity
level, or sits in an adult group) is stored the same way: keyed by
:func:`tag_hash.hash_tag`, its text encoded. It is served under the names the
caller knows (the vocabulary, the library's tags), never listed by itself.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from pathlib import Path

from .tag_hash import decode_text, encode_text, hash_tag

logger = logging.getLogger("moire.tag_descriptions")

PATH = Path(__file__).resolve().parents[1] / "data" / "tag_descriptions.json"

_cache: tuple[dict[str, str], dict[str, str]] | None = None
# The last merge, keyed by what it used: the tag list is read once per file,
# so a new download is a new alias map; the names change with the library.
_merged: tuple[object, dict[str, str], tuple, dict[str, str]] | None = None


def hidden(tag: str) -> bool:
    """Whether a tag's description is stored by hash, as its tag-group entry
    is (:func:`attire.hide_entry`): it has a level or an adult group."""
    from . import attire, tag_sensitivity

    return tag_sensitivity.level_of(tag) > 0 or attire.entries().is_hashed(tag)


def shipped_form(descriptions: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    """``(descriptions, hashed)`` as the shipped file stores them: the
    :func:`hidden` tags keyed by hash, their text encoded
    (scripts/build_tag_descriptions.py writes this)."""
    named: dict[str, str] = {}
    hashed: dict[str, str] = {}
    for tag, text in descriptions.items():
        if hidden(tag):
            hashed[hash_tag(tag)] = encode_text(text)
        else:
            named[tag] = text
    return named, dict(sorted(hashed.items()))


def _load() -> tuple[dict[str, str], dict[str, str]]:
    """``(tag -> description, hash -> encoded description)``; empty when the
    file is missing or unreadable. Read once; a failed read isn't kept, so a
    later call tries again."""
    global _cache
    if _cache is None:
        try:
            with open(PATH, encoding="utf-8") as f:
                doc = json.load(f)
            _cache = (dict(doc["descriptions"]), dict(doc.get("hashed", {})))
        except (OSError, ValueError, KeyError) as exc:
            logger.warning("tag descriptions unavailable: %s", exc)
            return {}, {}
    return _cache


def load() -> dict[str, str]:
    """``tag -> description`` for the tags stored by name."""
    return _load()[0]


def known(names: Iterable[str]) -> dict[str, str]:
    """The descriptions stored by hash, for those of ``names`` that have one."""
    hashed = _load()[1]
    out: dict[str, str] = {}
    for name in names:
        key = name.lower()
        if key not in out and (stored := hashed.get(hash_tag(key))):
            out[key] = decode_text(stored)
    return out


def served(aliases: dict[str, str], names: Iterable[str] = ()) -> dict[str, str]:
    """:func:`with_aliases` over the shipped file, with the hashed entries of
    ``names`` (and of the tags those aliases name). Kept until the list or
    the names change."""
    global _merged
    named, _hashed = _load()
    names = tuple(names)
    if (
        _merged is None
        or _merged[0] is not named
        or _merged[1] is not aliases
        or _merged[2] != names
    ):
        descriptions = {**named, **known([*names, *aliases.values()])}
        _merged = (named, aliases, names, with_aliases(descriptions, aliases))
    return _merged[3]


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
