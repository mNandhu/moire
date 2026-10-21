"""Re-tagging from the image view: POST /ai/tag with `retag` clears the image's
AI tags, tagger metadata and rating before queueing it, and keeps the rest."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t

pytestmark = pytest.mark.asyncio


def _row(image_id: str):
    with db.sync_conn() as conn:
        return conn.execute(sa.select(t.images).where(t.images.c._id == image_id)).one()


async def test_retag_clears_ai_tags_and_rating(client, seed):
    seed(
        "L1:a.png",
        tags=("1girl", "smile", "manual:fav", "prompt:smile"),
        rating="questionable",
    )
    resp = await client.post("/ai/tag", json={"ids": ["L1:a.png"], "retag": True})
    assert resp.status_code == 200, resp.text
    assert resp.json()["queued"] == 1

    row = _row("L1:a.png")
    assert row.tags == ["manual:fav", "prompt:smile"]
    assert row.has_ai_tags is False
    assert row.rating == "-"
    assert row.ai is None


async def test_plain_tag_keeps_existing_ai_tags(client, seed):
    seed("L1:b.png", tags=("1girl",), rating="general")
    resp = await client.post("/ai/tag", json={"ids": ["L1:b.png"]})
    assert resp.status_code == 200, resp.text
    row = _row("L1:b.png")
    assert row.tags == ["1girl"]
    assert row.rating == "general"
