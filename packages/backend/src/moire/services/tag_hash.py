"""How shipped data keeps some tags out of plain sight.

The sensitivity list, and the entries of the tag groups and descriptions
files for tags that have a level, are keyed by :func:`hash_tag` instead of the
tag's name, and a description's text is stored with :func:`encode_text`. The
app finds them by name all the same: it hashes the name it is looking up.
"""

from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

# Hex characters of a tag's SHA-256 kept as its key.
HASH_CHARS = 16


@lru_cache(maxsize=1 << 18)
def hash_tag(name: str) -> str:
    """A tag's key in shipped data: its lower-case name, hashed."""
    return hashlib.sha256(name.lower().encode()).hexdigest()[:HASH_CHARS]


def encode_text(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def decode_text(stored: str) -> str:
    return base64.b64decode(stored).decode()
