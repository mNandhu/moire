"""Each image's shuffle key: a random number in [0, 1) that the "shuffle"
feed order and the random picks (``feed.random_run``) walk on their own index.

The scanner gives a new image its key (``scanner.image_upsert_values``); a
reshuffle re-rolls every key, so the shuffled feed comes out in a new order.
A row without a key (an image indexed before keys existed, until its
migration ran) sorts as 0.
"""

from __future__ import annotations

import sqlalchemy as sa

from ...database.db import async_tx, sync_tx
from ...database import schema as t

# SQLite's random() is a 64-bit signed integer: its low 53 bits, scaled, are
# a double in [0, 1) exactly (the whole value would round up to 1.0 at the top).
_RANDOM_UNIT = sa.text("(random() & 9007199254740991) / 9007199254740992.0")

# Rows re-rolled per write transaction. SQLite has one writer: a whole large
# library in one UPDATE (three indexes rewritten with it) could hold the lock
# past the scanner's and the AI job's busy timeout.
_CHUNK = 5000


def _reroll(lo: int, hi: int, *, only_missing: bool):
    rowid = sa.literal_column("rowid")
    stmt = (
        sa.update(t.images)
        .where(rowid >= lo, rowid < hi)
        .values(shuffle_key=_RANDOM_UNIT)
    )
    if only_missing:
        stmt = stmt.where(t.images.c.shuffle_key.is_(None))
    return stmt


_TOP_ROWID = sa.select(sa.func.max(sa.literal_column("rowid"))).select_from(t.images)


async def reshuffle() -> int:
    """Give every image a new key, ``_CHUNK`` rows per transaction. Returns
    the images re-rolled. A feed paged while it runs can see both orders;
    the client starts its shuffled feed over once it is done."""
    async with async_tx() as conn:
        top = (await conn.execute(_TOP_ROWID)).scalar() or 0
    done = 0
    for lo in range(0, top + 1, _CHUNK):
        async with async_tx() as conn:
            res = await conn.execute(_reroll(lo, lo + _CHUNK, only_missing=False))
            done += res.rowcount
    return done


def fill_missing() -> None:
    """Give every image without a key one (the data migration for images
    indexed before keys existed). Idempotent."""
    with sync_tx() as conn:
        top = conn.execute(_TOP_ROWID).scalar() or 0
    for lo in range(0, top + 1, _CHUNK):
        with sync_tx() as conn:
            conn.execute(_reroll(lo, lo + _CHUNK, only_missing=True))
