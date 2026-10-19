"""Extraction settings: the keywords prompt guessing scores texts by
(:mod:`services.prompt_guess`).

Stored in the ``app_settings`` row "extraction". Until the user saves lists,
the defaults apply, so improving the defaults reaches everyone who hasn't
customised theirs. Saving reprojects every image, since a changed list can
guess (or stop guessing) any image whose graph has no readable prompt.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database import schema as t
from ..database.db import async_conn, async_tx, sync_conn
from . import prompt_guess

_ROW = "extraction"


def _lists(doc: dict | None) -> tuple[list[str], list[str]]:
    doc = doc or {}
    pos, neg = doc.get("guess_positive"), doc.get("guess_negative")
    return (
        list(pos) if isinstance(pos, list) else list(prompt_guess.DEFAULT_POSITIVE),
        list(neg) if isinstance(neg, list) else list(prompt_guess.DEFAULT_NEGATIVE),
    )


def load_keywords() -> prompt_guess.Keywords:
    """The stored keywords, for the reprojection thread. Sync."""
    with sync_conn() as conn:
        doc = conn.execute(
            sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == _ROW)
        ).scalar()
    pos, neg = _lists(doc)
    return prompt_guess.Keywords(frozenset(pos), frozenset(neg))


async def get_settings() -> dict[str, Any]:
    async with async_conn() as conn:
        doc = (
            await conn.execute(
                sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == _ROW)
            )
        ).scalar()
        guessed = (
            await conn.execute(
                sa.select(sa.func.count()).where(
                    sa.func.json_array_length(t.images.c.gen, "$.guessed") > 0
                )
            )
        ).scalar_one()
    pos, neg = _lists(doc)
    return {
        "guess_positive": pos,
        "guess_negative": neg,
        "default_positive": list(prompt_guess.DEFAULT_POSITIVE),
        "default_negative": list(prompt_guess.DEFAULT_NEGATIVE),
        "guessed_images": guessed,
    }


async def set_keywords(positive: Any, negative: Any) -> None:
    doc = {
        "guess_positive": prompt_guess.clean_keywords(positive),
        "guess_negative": prompt_guess.clean_keywords(negative),
    }
    async with async_tx() as conn:
        stmt = sqlite_insert(t.app_settings).values(_id=_ROW, doc=doc)
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.app_settings.c._id], set_={"doc": stmt.excluded.doc}
        )
        await conn.execute(stmt)
