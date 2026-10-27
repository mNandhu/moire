"""The wear rule: the pure form (image view) and the SQL form (gallery filter)
say the same thing."""

from __future__ import annotations

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.outfit_wear import WearRule, wear_condition, wears, wears_most

IMAGES = {
    "L1:abc": ("a", "b", "c"),
    "L1:ab": ("a", "prompt:b"),
    # One base from two sources counts once.
    "L1:aa": ("a", "prompt:a", "manual:a"),
    "L1:z": ("z",),
    "L1:thumb": ("z",),
}


def test_wears_most_is_two_thirds_rounded_up():
    assert [wears_most(n) for n in range(7)] == [0, 1, 2, 2, 3, 4, 4]


def test_wears_matches_the_thumbnail_or_most_tags():
    rule = WearRule(("a", "b", "c"), 2, "img")
    assert wears(rule, "img", [])
    assert wears(rule, "x", ["a", "c", "z"])
    assert not wears(rule, "x", ["a"])
    assert not wears(WearRule((), 0, None), "x", ["a"])


@pytest.mark.parametrize(
    "rule",
    [
        WearRule(("a", "b", "c"), 3, None),
        WearRule(("a", "b", "c"), 2, None),
        WearRule(("a", "b"), 2, None),
        WearRule(("a",), 1, None),
        WearRule(("a", "b", "c"), 2, "L1:thumb"),
        WearRule((), 0, "L1:thumb"),
        WearRule((), 0, None),
        WearRule(("q",), 1, "L1:gone"),
    ],
)
async def test_sql_and_pure_wear_rules_agree(seed, rule):
    for image_id, tags in IMAGES.items():
        seed(image_id, tags=tags)
    bases = {image_id: set() for image_id in IMAGES}
    async with db.async_conn() as conn:
        for image_id, base in await conn.execute(
            sa.select(t.image_tags.c.image_id, t.image_tags.c.base)
        ):
            bases[image_id].add(base)
        in_sql = set(
            (
                await conn.execute(
                    sa.select(t.images.c._id).where(wear_condition(rule))
                )
            ).scalars()
        )
    pure = {i for i in IMAGES if wears(rule, i, bases[i])}
    assert in_sql == pure
