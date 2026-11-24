"""When the image view last showed an image, and the "not opened lately"
filter that reads it (Discover's Forgotten favorites)."""

import time

import sqlalchemy as sa

from moire.database import db, schema as t
from moire.services.library import scanner


def _viewed() -> dict[str, float | None]:
    with db.sync_conn() as conn:
        rows = conn.execute(sa.select(t.images.c._id, t.images.c.last_viewed_at))
        return {i: v for i, v in rows}


def _set_viewed(image_id: str, at: float) -> None:
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images)
            .where(t.images.c._id == image_id)
            .values(last_viewed_at=at)
        )


async def _ids(client, **params):
    resp = await client.get("/images", params=params)
    assert resp.status_code == 200, resp.text
    return sorted(r["_id"] for r in resp.json())


async def test_opening_an_image_stamps_it(client, seed):
    seed("L1:a")
    seed("L1:b")
    before = time.time()
    resp = await client.post("/images/L1:a/viewed")
    assert resp.status_code == 204
    viewed = _viewed()
    assert viewed["L1:a"] is not None and viewed["L1:a"] >= before
    assert viewed["L1:b"] is None
    # Nothing the image view shows.
    detail = (await client.get("/images/L1:a")).json()
    assert "last_viewed_at" not in detail


async def test_viewing_an_unknown_image_is_404(client, seed):
    resp = await client.post("/images/L1:nope/viewed")
    assert resp.status_code == 404


async def test_unviewed_days_keeps_images_not_opened_lately(client, seed):
    seed("L1:never")
    seed("L1:old")
    seed("L1:recent")
    now = time.time()
    _set_viewed("L1:old", now - 40 * 86400)
    _set_viewed("L1:recent", now - 2 * 86400)
    assert await _ids(client, unviewed_days=30) == ["L1:never", "L1:old"]
    assert await _ids(client, unviewed_days=1) == ["L1:never", "L1:old", "L1:recent"]
    await client.post("/images/L1:old/viewed")
    assert await _ids(client, unviewed_days=30) == ["L1:never"]


async def test_forgotten_favorites_pick(client, seed):
    seed("L1:fav", score=5, shuffle_key=0.1)
    seed("L1:seen_fav", score=5, shuffle_key=0.2)
    seed("L1:meh", score=2, shuffle_key=0.3)
    _set_viewed("L1:seen_fav", time.time())
    resp = await client.get(
        "/images/random", params={"min_score": 4, "unviewed_days": 30}
    )
    assert [r["_id"] for r in resp.json()] == ["L1:fav"]


async def test_unviewed_days_range(client, seed):
    for bad in (0, 3651):
        resp = await client.get("/images", params={"unviewed_days": bad})
        assert resp.status_code == 422


def test_a_rescan_keeps_when_it_was_viewed():
    stmt = scanner.image_upsert_stmt()
    assert "last_viewed_at" not in str(stmt.compile()).split("ON CONFLICT")[1]


async def test_a_hidden_image_is_not_stamped(client, seed, monkeypatch):
    from moire.services.tags import sensitivity_filter

    seed("L1:sensitive", rating="questionable")
    monkeypatch.setattr(sensitivity_filter, "_max", 0)
    resp = await client.post("/images/L1:sensitive/viewed")
    assert resp.status_code == 404
    assert _viewed()["L1:sensitive"] is None


def test_one_filter_has_one_cutoff():
    from dataclasses import replace

    from moire.services.images.feed import FeedFilter

    f = FeedFilter(unviewed_days=30)
    assert f.viewed_before is not None
    assert abs(f.viewed_before - (time.time() - 30 * 86400)) < 60
    # Copies made while resolving it keep the same cutoff.
    assert replace(f, sort="shuffle").viewed_before == f.viewed_before
    assert FeedFilter().viewed_before is None
