"""Integration tests for the single-image scalar mutations (rating / score /
quarantine), the writes that now pass through image_tags' scalar setters so the
documented single-owner rule holds. Exercised through the real ASGI app."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t

pytestmark = pytest.mark.asyncio


async def _row(image_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
        ).first()


async def test_set_rating_persists(client, seed):
    seed("L1:a")
    resp = await client.post("/images/L1:a/rating", json={"rating": "general"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"_id": "L1:a", "rating": "general"}
    assert (await _row("L1:a")).rating == "general"


async def test_set_rating_rejects_unknown_value(client, seed):
    seed("L1:a")
    resp = await client.post("/images/L1:a/rating", json={"rating": "spicy"})
    assert resp.status_code == 422


async def test_set_rating_404_on_unknown_image(client):
    resp = await client.post("/images/L1:ghost/rating", json={"rating": "general"})
    assert resp.status_code == 404


async def test_set_score_persists_and_validates_range(client, seed):
    seed("L1:a")
    assert (
        await client.post("/images/L1:a/score", json={"score": 4})
    ).status_code == 200
    assert (await _row("L1:a")).score == 4
    assert (
        await client.post("/images/L1:a/score", json={"score": 9})
    ).status_code == 422


async def test_set_quarantine_toggles_and_hides_from_feed(client, seed):
    seed("L1:a")
    resp = await client.post("/images/L1:a/quarantine", json={"quarantined": True})
    assert resp.status_code == 200
    assert (await _row("L1:a")).quarantined is True
    # Quarantined images leave the default feed.
    feed = await client.get("/images")
    assert "L1:a" not in [it["_id"] for it in feed.json()]


async def test_mutation_resolves_slash_variant(client, seed):
    # Stored with a backslash; request comes in with a forward slash.
    seed("L1:sub\\img.png")
    resp = await client.post(
        "/images/L1:sub/img.png/rating", json={"rating": "general"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["_id"] == "L1:sub\\img.png"
    assert (await _row("L1:sub\\img.png")).rating == "general"
