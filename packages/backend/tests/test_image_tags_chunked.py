"""Bulk tag rewrites commit in chunks: a failure part-way keeps the earlier
chunks whole, and the tag index is dirtied once after the run."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import image_tags, tag_index

pytestmark = pytest.mark.asyncio


def _tags(image_id: str) -> list[str]:
    with db.sync_conn() as conn:
        return conn.execute(
            sa.select(t.images.c.tags).where(t.images.c._id == image_id)
        ).scalar()


def _join_tags(image_id: str) -> set[str]:
    with db.sync_conn() as conn:
        return {
            r.tag
            for r in conn.execute(
                sa.select(t.image_tags.c.tag).where(t.image_tags.c.image_id == image_id)
            )
        }


def _fail_on_second_chunk(monkeypatch):
    real = image_tags._persist
    seen: list[str] = []

    async def flaky(conn, image_id, new_tags, extra=None):
        seen.append(image_id)
        if len(seen) == 3:  # first image of the second chunk (size 2)
            raise RuntimeError("boom")
        return await real(conn, image_id, new_tags, extra=extra)

    monkeypatch.setattr(image_tags, "_persist", flaky)


async def test_clear_ai_all_failure_keeps_earlier_chunks_consistent(
    temp_db, seed, monkeypatch
):
    monkeypatch.setattr(image_tags, "_CHUNK", 2)
    ids = [f"L1:{i}.png" for i in range(4)]
    for i in ids:
        seed(i, tags=("cat", "manual:keep"))
    _fail_on_second_chunk(monkeypatch)
    gen = tag_index.current_generation()

    with pytest.raises(RuntimeError):
        await image_tags.clear_ai_all()

    # Chunk one committed: array, flags and join rows agree. Chunk two rolled back.
    for i in ids[:2]:
        assert _tags(i) == ["manual:keep"]
        assert _join_tags(i) == {"manual:keep"}
    for i in ids[2:]:
        assert _tags(i) == ["cat", "manual:keep"]
        assert _join_tags(i) == {"cat", "manual:keep"}
    # The committed part is visible, so the index was dirtied despite the failure.
    assert tag_index.current_generation() > gen


async def test_rename_manual_failure_keeps_earlier_chunks_consistent(
    temp_db, seed, monkeypatch
):
    monkeypatch.setattr(image_tags, "_CHUNK", 2)
    ids = [f"L1:{i}.png" for i in range(4)]
    for i in ids:
        seed(i, tags=("manual:old",))
    _fail_on_second_chunk(monkeypatch)

    with pytest.raises(RuntimeError):
        await image_tags.rename_manual("manual:old", "manual:new")

    assert len({tuple(_tags(i)) for i in ids[:2]}) == 1
    for i in ids[:2]:
        assert _tags(i) == ["manual:new"]
        assert _join_tags(i) == {"manual:new"}
    for i in ids[2:]:
        assert _tags(i) == ["manual:old"]


async def test_chunked_rewrites_cover_every_image_and_dirty_the_index(
    temp_db, seed, monkeypatch
):
    monkeypatch.setattr(image_tags, "_CHUNK", 2)
    for i in range(5):
        seed(f"L1:{i}.png", tags=("cat", "manual:old"))
    gen = tag_index.current_generation()

    assert await image_tags.rename_manual("manual:old", "manual:new") == 5
    assert tag_index.current_generation() == gen + 1
    assert await image_tags.clear_ai_all() == (5, 5)
    assert tag_index.current_generation() == gen + 2
    assert all(_tags(f"L1:{i}.png") == ["manual:new"] for i in range(5))


async def test_bulk_manual_splits_above_the_atomic_cap(temp_db, seed, monkeypatch):
    monkeypatch.setattr(image_tags, "_BULK_ATOMIC", 2)
    ids = [f"L1:{i}.png" for i in range(5)]
    for i in ids:
        seed(i)
    assert await image_tags.bulk_manual(ids, add=["fav"], remove=[]) == (5, 5)
    assert all(_tags(i) == ["manual:fav"] for i in ids)
