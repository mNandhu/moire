"""Extraction settings: the keywords prompt guessing scores texts by
(:mod:`services.prompt_guess`), and :class:`ExtractionConfig`, everything
extraction reads besides a signature's ruleset.

Keywords are stored in the ``app_settings`` row "extraction". Until the user
saves lists, the defaults apply, so improving the defaults reaches everyone who
hasn't customised theirs. Saving reprojects every image, since a changed list
can guess (or stop guessing) any image whose graph has no readable prompt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database import schema as t
from ..database.db import async_conn, async_tx, sync_conn
from . import ai_settings, prompt_guess

_ROW = "extraction"


@dataclass(frozen=True)
class ExtractionConfig:
    """What deriving ``gen.*`` reads besides the ruleset: the guessing
    keywords, the positive-only switch (stored with the AI settings) and the
    prompt-tag rules (``from -> [to, ...]``, see services/tag_rename.py).
    Reprojection and the rules preview both load it here and derive through
    :func:`services.gen_metadata.derive`, so they can't disagree."""

    keywords: prompt_guess.Keywords
    positive_only: bool
    aliases: dict[str, list[str]]


def _lists(doc: dict | None) -> tuple[list[str], list[str]]:
    doc = doc or {}
    pos, neg = doc.get("guess_positive"), doc.get("guess_negative")
    return (
        list(pos) if isinstance(pos, list) else list(prompt_guess.DEFAULT_POSITIVE),
        list(neg) if isinstance(neg, list) else list(prompt_guess.DEFAULT_NEGATIVE),
    )


def _keywords(doc: dict | None) -> prompt_guess.Keywords:
    pos, neg = _lists(doc)
    return prompt_guess.Keywords(frozenset(pos), frozenset(neg))


def _doc_stmt(row: str):
    return sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == row)


_RULES_STMT = sa.select(t.tag_rules.c.from_name, t.tag_rules.c.to_names)


def _config(keywords_doc, ai_doc, rules) -> ExtractionConfig:
    return ExtractionConfig(
        keywords=_keywords(keywords_doc),
        positive_only=ai_settings.prompt_positive_only(ai_doc),
        aliases={r.from_name: list(r.to_names) for r in rules},
    )


def load_sync() -> ExtractionConfig:
    """The stored extraction config, for the reprojection thread."""
    with sync_conn() as conn:
        return _config(
            conn.execute(_doc_stmt(_ROW)).scalar(),
            conn.execute(_doc_stmt(ai_settings.ROW)).scalar(),
            conn.execute(_RULES_STMT).fetchall(),
        )


async def load() -> ExtractionConfig:
    """The stored extraction config, for the rules preview."""
    async with async_conn() as conn:
        return _config(
            (await conn.execute(_doc_stmt(_ROW))).scalar(),
            (await conn.execute(_doc_stmt(ai_settings.ROW))).scalar(),
            (await conn.execute(_RULES_STMT)).fetchall(),
        )


async def get_settings() -> dict[str, Any]:
    async with async_conn() as conn:
        doc = (await conn.execute(_doc_stmt(_ROW))).scalar()
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
