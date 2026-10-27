"""Merge and split rules (``tag_rules``): the user's rewrites of prompt tags,
``from -> [to, ...]``, one target merging, several splitting.

Readers and the pure application live here; :mod:`services.tag_rename`
writes the rules and re-derives the images they touch. Extraction reads them
through :mod:`services.extraction_settings` (reprojection, the rules
preview) and applies them in :func:`services.gen_metadata.derive`. Only the
schema is imported, so the pure prompt parser can share this module. Not to
be confused with a Danbooru alias or a character's bare-name alias.
"""

from __future__ import annotations

import sqlalchemy as sa

from ..database import schema as t

_STMT = sa.select(
    t.tag_rules.c.from_name, t.tag_rules.c.to_names, t.tag_rules.c.created_at
)


def _targets(rows) -> dict[str, list[str]]:
    return {r.from_name: list(r.to_names) for r in rows}


def load_rules_sync(conn) -> dict[str, list[str]]:
    """Every rule as ``from -> [to, ...]``, on a sync connection (the
    reprojection thread)."""
    return _targets(conn.execute(_STMT))


async def load_rules(conn) -> dict[str, list[str]]:
    """Every rule as ``from -> [to, ...]``."""
    return _targets(await conn.execute(_STMT))


async def load_dated(conn) -> dict[str, tuple[list[str], float | None]]:
    """Every rule as ``from -> ([to, ...], created_at)``."""
    return {
        r.from_name: (list(r.to_names), r.created_at) for r in await conn.execute(_STMT)
    }


def apply_rules(terms: list[str], rules: dict[str, list[str]]) -> list[str]:
    """Map prompt terms through the rules, then sort and dedupe, the stored
    shape of ``gen.prompt_terms``. One hop: rules are kept resolved (no
    ``a -> b -> c`` chains) by their writer. Pure."""
    if not rules:
        return terms
    return sorted({to for term in terms for to in rules.get(term, (term,))})


def apply_rule_weights(
    weights: dict[str, float], rules: dict[str, list[str]]
) -> dict[str, float]:
    """``gen.prompt_weights`` through the same rules as :func:`apply_rules`:
    each target takes its source's weight, and where several sources merge
    into one target the weight farthest from 1 wins (the first on a tie, as
    within one prompt). Pure."""
    if not rules:
        return weights
    out: dict[str, float] = {}
    for term, w in weights.items():
        for to in rules.get(term, (term,)):
            if abs(w - 1) > abs(out.get(to, 1.0) - 1):
                out[to] = w
    return out
