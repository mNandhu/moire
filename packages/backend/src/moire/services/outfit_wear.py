"""When an image wears an outfit: the rule, said twice side by side.

:func:`wears` is the rule for one image in Python (the image view's worn
outfits); :func:`wear_condition` is the same rule in SQL (the gallery's
outfit filter). Keep the two together: a test checks they agree. Looking an
outfit up into a rule (``outfits.wear_rule``) stays in :mod:`services.outfits`.
"""

from __future__ import annotations

import math
from typing import Iterable, NamedTuple

import sqlalchemy as sa

from ..database import schema as t

# How much of an outfit an image must wear to match the gallery's outfit
# filter: two thirds of its tags, rounded up (1 of 1, 2 of 3, 4 of 6).
WEARS_MOST = 2 / 3


def wears_most(n: int) -> int:
    """Tags of ``n`` an image must carry to wear the outfit. Pure."""
    return max(1, math.ceil(n * WEARS_MOST - 1e-9)) if n else 0


class WearRule(NamedTuple):
    """When an image wears an outfit: it carries ``need`` of ``tags``, or it
    is the outfit's own thumbnail (``image_id``), which wears it by being
    picked, whatever its tags say."""

    tags: tuple[str, ...]
    need: int
    image_id: str | None


def wears(rule: WearRule, image_id: str, bases: Iterable[str]) -> bool:
    """Whether one image (its tag bases) wears the outfit. Pure; the same
    rule as :func:`wear_condition`."""
    if image_id == rule.image_id:
        return True
    return bool(rule.tags) and len(set(rule.tags) & set(bases)) >= rule.need


def wear_condition(rule: WearRule) -> sa.ColumnElement[bool]:
    """:func:`wears` as a condition on ``images`` rows: its thumbnail, or
    carries ``need`` of its tags, from any source."""
    it = t.image_tags
    either = []
    if rule.image_id:
        either.append(t.images.c._id == rule.image_id)
    if rule.tags:
        either.append(
            t.images.c._id.in_(
                sa.select(it.c.image_id)
                .where(it.c.base.in_(rule.tags))
                .group_by(it.c.image_id)
                .having(sa.func.count(sa.distinct(it.c.base)) >= rule.need)
            )
        )
    return sa.or_(*either) if either else sa.false()
