"""The one-off underscore migration: spaced tags become canonical, the ai
subdoc follows, duplicate spellings collapse, and it runs once."""

import pytest
import sqlalchemy as sa

from src.database import db
from src.database import schema as t
from src.services import tag_migrations

pytestmark = pytest.mark.asyncio


async def _row(image_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
        ).first()


async def test_migration_rewrites_tags_ai_meta_and_pins(temp_db, seed):
    seed("L1:a", tags=("blue eyes", "^_^", "manual:my pick", "prompt:blue eyes"))
    seed("L1:b", tags=("long hair", "manual:long hair", "manual:long_hair"))
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images)
            .where(t.images.c._id == "L1:a")
            .values(
                ai={"general_tags": [["blue eyes", 0.9], ["^_^", 0.5]], "caption": "x"}
            )
        )
        conn.execute(
            sa.insert(t.tag_meta),
            [
                {"tag": "blue eyes", "thumb_image_id": "L1:a", "updated_at": 1.0},
                {"tag": "blue_eyes", "thumb_image_id": "L1:b", "updated_at": 2.0},
            ],
        )

    tag_migrations.run_pending()

    a = await _row("L1:a")
    assert a.tags == ["blue_eyes", "^_^", "manual:my_pick", "prompt:blue_eyes"]
    assert a.ai["general_tags"] == [["blue_eyes", 0.9], ["^_^", 0.5]]
    assert a.has_ai_tags is True
    b = await _row("L1:b")
    assert b.tags == ["long_hair", "manual:long_hair"]
    async with db.async_conn() as conn:
        rows = {r.tag for r in (await conn.execute(sa.select(t.image_tags))).fetchall()}
        pins = (await conn.execute(sa.select(t.tag_meta))).fetchall()
    assert "blue eyes" not in rows and "blue_eyes" in rows
    assert [(p.tag, p.thumb_image_id) for p in pins] == [("blue_eyes", "L1:b")]


async def test_migration_runs_once(temp_db, seed):
    tag_migrations.run_pending()
    seed("L1:a", tags=("blue eyes",))  # written after: left alone
    tag_migrations.run_pending()
    assert (await _row("L1:a")).tags == ["blue eyes"]
