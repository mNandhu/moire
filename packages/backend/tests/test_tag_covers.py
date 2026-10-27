"""Tag covers: the one service that writes a tag's cover pin (``tag_meta``)
and its framing (``tag_focus``)."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import tag_covers, tag_index

pytestmark = pytest.mark.asyncio


async def _pin(tag):
    async with db.async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.tag_meta.c.thumb_image_id).where(t.tag_meta.c.tag == tag)
            )
        ).scalar()


async def _focus(tag):
    async with db.async_conn() as conn:
        row = (
            await conn.execute(sa.select(t.tag_focus).where(t.tag_focus.c.tag == tag))
        ).first()
    return None if row is None else (row.image_id, row.focus_x, row.focus_y)


async def test_set_pin_needs_an_image_carrying_one_of_the_names(seed):
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("dog",))
    assert await tag_covers.set_pin("cat", ["cat"], "L1:b") is None
    assert await _pin("cat") is None
    assert await tag_covers.set_pin("cat", ["cat"], "L1:a") == "L1:a"
    assert await _pin("cat") == "L1:a"


async def test_a_pin_by_a_backslash_spelling_keeps_the_stored_id(client, seed):
    seed("L1:sub/a.png", tags=("cat",))
    r = await client.post("/tags/thumbnail/cat", json={"image_id": "L1:sub\\a.png"})
    assert r.status_code == 200
    assert r.json()["thumb_image_id"] == "L1:sub/a.png"
    assert await _pin("cat") == "L1:sub/a.png"


async def test_set_pin_replaces_and_clear_pin_drops_and_both_invalidate(seed):
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("prompt:cat",))
    gen = tag_index.current_generation()
    await tag_covers.set_pin("cat", ["cat"], "L1:a")
    await tag_covers.set_pin("cat", ["cat"], "L1:b")
    assert await _pin("cat") == "L1:b"
    assert tag_index.current_generation() == gen + 2
    await tag_covers.clear_pin("cat")
    assert await _pin("cat") is None
    assert tag_index.current_generation() == gen + 3


async def test_move_carries_the_focus_even_without_a_pin(seed):
    await tag_covers.put_focus("old", (0.2, 0.3), "L1:a")
    async with db.async_tx() as conn:
        await tag_covers.move(conn, "old", "new")
    assert await _focus("old") is None
    assert await _focus("new") == ("L1:a", 0.2, 0.3)


async def test_move_keeps_the_targets_own_pin_and_focus(seed):
    seed("L1:a", tags=("old",))
    seed("L1:b", tags=("new",))
    await tag_covers.set_pin("old", ["old"], "L1:a")
    await tag_covers.set_pin("new", ["new"], "L1:b")
    await tag_covers.put_focus("old", (0.1, 0.1), "L1:a")
    await tag_covers.put_focus("new", (0.9, 0.9), "L1:b")
    async with db.async_tx() as conn:
        await tag_covers.move(conn, "old", "new")
    assert await _pin("new") == "L1:b"
    assert await _pin("old") is None
    assert await _focus("new") == ("L1:b", 0.9, 0.9)
    assert await _focus("old") is None


async def test_move_carries_a_pin_to_a_target_without_one(seed):
    seed("L1:a", tags=("old",))
    await tag_covers.set_pin("old", ["old"], "L1:a")
    async with db.async_tx() as conn:
        await tag_covers.move(conn, "old", "new")
    assert await _pin("new") == "L1:a"
    assert await _pin("old") is None
