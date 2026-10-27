"""Tag *names*: the one canonical spelling every tag kind is stored in.

Tags are stored Danbooru-style, with underscores between words
(``blue_eyes``, ``hu_tao_(genshin_impact)``), the WD tagger's own vocabulary.
``blue eyes`` and ``blue_eyes`` are the same tag, so every writer (the tagger,
prompt extraction, manual adds) and every reader that takes a tag from the
user (feed filter, prompt-term search, tag routes) passes names through
:func:`canonical_name` first. The UI shows underscores as spaces; that is a
display concern only (``lib/tags.ts`` ``formatTag``).

Pure and dependency-free, so the pure prompt parser can share it with the
tag-state owner (:mod:`services.image_tags`) without importing the database.
"""

from __future__ import annotations

import re

# WD tagger vocabulary entries whose underscore is part of the face, not a word
# separator. Displayed as-is (never as spaces); mirrored in `lib/tags.ts`.
KAOMOJIS = frozenset(
    {
        "0_0",
        "(o)_(o)",
        "+_+",
        "+-",
        "._.",
        "<o>_<o>",
        "<|>_<|>",
        "=_=",
        ">_<",
        "3_3",
        "6_9",
        ">_o",
        "@_@",
        "^_^",
        "o_o",
        "u_u",
        "x_x",
        "|_|",
        "||_||",
    }
)

_WS = re.compile(r"\s+")


def canonical_name(name: str) -> str:
    """The stored spelling of a bare tag name: trimmed, each whitespace run one
    underscore. Idempotent. Case is kept (manual tags are the user's words).
    Lora tokens (``<lora:a b:0.8>``) are prompt syntax, not tag names, and pass
    through untouched."""
    s = name.strip()
    if s.startswith("<"):
        return s
    return _WS.sub("_", s)


def display_tag(name: str) -> str:
    """The display form of a tag name: underscores read as spaces, except in a
    kaomoji, whose underscore is part of the face. Backend twin of
    ``lib/tags.ts`` ``formatTag``."""
    return name if name in KAOMOJIS else name.replace("_", " ")
