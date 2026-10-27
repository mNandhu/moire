"""Integration tests for the scanner's SQLite write path: the ON CONFLICT upsert
must refresh file metadata while leaving tag-state untouched (the old
``$setOnInsert`` behavior), and reproject must persist gen.* + prompt-term rows."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import scanner

pytestmark = pytest.mark.asyncio


async def _img(image_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
        ).first()


def _upsert(doc: dict) -> None:
    with db.sync_tx() as conn:
        stmt = scanner.image_upsert_stmt()
        conn.execute(stmt, scanner.image_upsert_values(doc))


async def test_upsert_inserts_with_initial_tag_state(temp_db):
    _upsert({"_id": "L1:x.jpg", "library_id": "L1", "path": "/lib/x.jpg", "size": 10})
    row = await _img("L1:x.jpg")
    assert row.path == "/lib/x.jpg"
    assert row.tags == []
    assert row.has_tags is False
    assert row.quarantined is False


async def test_upsert_refreshes_file_meta_but_preserves_tag_state(temp_db, seed):
    # Seed an already-tagged, rated, quarantined image (post-AI-tagging state).
    seed(
        "L1:x.jpg",
        tags=("1girl", "manual:fav"),
        rating="general",
        quarantined=True,
        score=4,
    )
    # A rescan upserts the same id with fresh file metadata.
    _upsert(
        {
            "_id": "L1:x.jpg",
            "library_id": "L1",
            "path": "/lib/NEW.jpg",
            "size": 999,
            "width": 123,
        }
    )
    row = await _img("L1:x.jpg")
    # File metadata refreshed...
    assert row.path == "/lib/NEW.jpg"
    assert row.size == 999
    assert row.width == 123
    # ...but tag-state is preserved (NOT reset to the insert defaults).
    assert row.tags == ["1girl", "manual:fav"]
    assert row.has_ai_tags is True
    assert row.rating == "general"
    assert row.quarantined is True
    assert row.score == 4


async def test_purge_cascades_tag_rows(client, seed):
    seed("L1:x.jpg", tags=("cat", "manual:fav"))
    # Sanity: join rows exist.
    async with db.async_conn() as conn:
        before = (
            await conn.execute(sa.select(sa.func.count()).select_from(t.image_tags))
        ).scalar()
    assert before == 2

    resp = await client.post("/images/L1:x.jpg/purge", json={"confirm": True})
    assert resp.status_code == 200, resp.text

    async with db.async_conn() as conn:
        after = (
            await conn.execute(sa.select(sa.func.count()).select_from(t.image_tags))
        ).scalar()
        img = (
            await conn.execute(
                sa.select(t.images.c._id).where(t.images.c._id == "L1:x.jpg")
            )
        ).first()
    assert img is None
    assert after == 0  # FK cascade removed the join rows
