"""Tag display settings: the boilerplate list.

Boilerplate tags are the ones that ride along on nearly every prompt and say
nothing about the image ("masterpiece", "best quality", "score_9"). The
frontend folds them away and ranks them last; search and filters are
unaffected. Entries match a tag's name from any source (AI, manual, prompt);
``*`` is a wildcard, and spaces and underscores are interchangeable (matching
lives in the frontend's lib/boilerplate.ts).

Stored in the ``app_settings`` row "tags". Until the user saves a list, the
defaults apply, so improving the defaults reaches everyone who hasn't
customised theirs.
"""

from __future__ import annotations

import re
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database import schema as t
from ..database.db import async_conn, async_tx

_ROW = "tags"
MAX_ENTRIES = 300
MAX_LEN = 100

DEFAULT_BOILERPLATE: tuple[str, ...] = (
    "masterpiece",
    "best quality",
    "amazing quality",
    "high quality",
    "good quality",
    "normal quality",
    "low quality",
    "worst quality",
    "very aesthetic",
    "aesthetic",
    "absurdres",
    "highres",
    "incredibly absurdres",
    "ultra detailed",
    "highly detailed",
    "extremely detailed",
    "very awa",
    "newest",
    "recent",
    "8k",
    "4k",
    "score_*",
    "source_*",
)


def _key(entry: str) -> str:
    """The form two entries are compared in: case, and space vs underscore,
    don't make a different entry."""
    return re.sub(r"[\s_]+", " ", entry.strip().lower())


def clean_boilerplate(entries: Any) -> list[str]:
    """Trimmed, lowercased, non-empty, de-duplicated (by :func:`_key`) and
    capped. Raises ValueError for anything that isn't a list of strings."""
    if not isinstance(entries, list) or not all(isinstance(e, str) for e in entries):
        raise ValueError("boilerplate must be a list of strings")
    out: list[str] = []
    seen: set[str] = set()
    for raw in entries:
        entry = " ".join(raw.strip().lower().split())
        if not entry or len(entry) > MAX_LEN:
            continue
        k = _key(entry)
        if k in seen or k.strip("* ") == "":
            # A bare "*" would fold every tag away.
            continue
        seen.add(k)
        out.append(entry)
        if len(out) >= MAX_ENTRIES:
            break
    return out


async def get_tag_settings() -> dict[str, Any]:
    async with async_conn() as conn:
        doc = (
            await conn.execute(
                sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == _ROW)
            )
        ).scalar()
    stored = (doc or {}).get("boilerplate")
    return {
        "boilerplate": list(stored)
        if isinstance(stored, list)
        else list(DEFAULT_BOILERPLATE),
        "default_boilerplate": list(DEFAULT_BOILERPLATE),
    }


async def set_boilerplate(entries: Any) -> dict[str, Any]:
    clean = clean_boilerplate(entries)
    async with async_tx() as conn:
        stmt = sqlite_insert(t.app_settings).values(
            _id=_ROW, doc={"boilerplate": clean}
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.app_settings.c._id], set_={"doc": stmt.excluded.doc}
        )
        await conn.execute(stmt)
    return await get_tag_settings()
