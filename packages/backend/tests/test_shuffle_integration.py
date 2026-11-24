"""The shuffle order, the random picks ("I'm feeling lucky") and a reshuffle."""

import sqlalchemy as sa

from moire.database import db, schema as t
from moire.services.images import feed as image_feed, shuffle
from moire.services.images.feed import FeedFilter
from moire.services.library import scanner
from moire.services.tags import migrations, sensitivity_filter


def _keys() -> dict[str, float | None]:
    with db.sync_conn() as conn:
        rows = conn.execute(sa.select(t.images.c._id, t.images.c.shuffle_key))
        return {i: k for i, k in rows}


def _seed_keyed(seed, n=12):
    for i in range(n):
        seed(f"L1:img{i:02d}", mtime=i, shuffle_key=(i * 7 % n) / n)


async def test_shuffle_feed_walks_the_keys(client, seed):
    _seed_keyed(seed)
    seen, cursor = [], None
    while True:
        params = {
            "sort": "shuffle",
            "limit": 5,
            **({"cursor": cursor} if cursor else {}),
        }
        resp = await client.get("/images", params=params)
        assert resp.status_code == 200
        seen += [r["_id"] for r in resp.json()]
        cursor = resp.headers.get("X-Next-Cursor")
        if not cursor:
            break
    keys = _keys()
    assert sorted(seen) == sorted(keys)  # every image once
    assert seen == sorted(keys, key=lambda i: (keys[i], i))


async def test_random_run_wraps_and_returns_each_image_once(seed):
    _seed_keyed(seed)
    rows = await image_feed.random_run(FeedFilter(), limit=50, start=0.6)
    ids = [r["_id"] for r in rows]
    keys = _keys()
    assert sorted(ids) == sorted(keys)
    # From the start point up, then round from the lowest key.
    assert [keys[i] >= 0.6 for i in ids] == sorted(
        (keys[i] >= 0.6 for i in ids), reverse=True
    )
    few = await image_feed.random_run(FeedFilter(), limit=3, start=0.6)
    assert [r["_id"] for r in few] == ids[:3]


async def test_random_respects_the_filter_and_hidden_images(client, seed, monkeypatch):
    seed("L1:shown", tags=("cat",), rating="general", shuffle_key=0.2)
    seed("L1:other", tags=("dog",), rating="general", shuffle_key=0.3)
    seed("L1:hidden", tags=("cat",), quarantined=True, shuffle_key=0.4)
    seed("L1:sensitive", tags=("cat",), rating="questionable", shuffle_key=0.5)
    resp = await client.get("/images/random", params={"tags": "cat"})
    assert resp.status_code == 200
    assert {r["_id"] for r in resp.json()} == {"L1:shown", "L1:sensitive"}
    assert all(r["thumb_url"] is None or "thumb" in r["thumb_url"] for r in resp.json())
    monkeypatch.setattr(sensitivity_filter, "_max", 0)
    resp = await client.get("/images/random", params={"tags": "cat"})
    assert [r["_id"] for r in resp.json()] == ["L1:shown"]


async def test_random_with_no_match_is_empty(client, seed):
    seed("L1:a", tags=("cat",), shuffle_key=0.1)
    resp = await client.get("/images/random", params={"tags": "nothing_here"})
    assert resp.status_code == 200
    assert resp.json() == []


async def test_random_limit_is_capped(client, seed):
    resp = await client.get(
        "/images/random", params={"limit": image_feed.RANDOM_RUN_CAP + 1}
    )
    assert resp.status_code == 422


async def test_reshuffle_rerolls_every_key(client, seed):
    _seed_keyed(seed)
    seed("L1:unkeyed")
    before = _keys()
    resp = await client.post("/images/reshuffle")
    assert resp.status_code == 200
    assert resp.json() == {"images": len(before)}
    after = _keys()
    assert all(k is not None and 0 <= k < 1 for k in after.values())
    assert after != before


async def test_migration_fills_only_missing_keys(seed):
    seed("L1:keyed", shuffle_key=0.25)
    seed("L1:unkeyed")
    shuffle.fill_missing()
    keys = _keys()
    assert keys["L1:keyed"] == 0.25
    assert keys["L1:unkeyed"] is not None
    assert any(name == "shuffle_keys" for name, _s, _r in migrations._MIGRATIONS)


def test_a_scanned_image_gets_a_key_a_rescan_keeps():
    row = scanner.image_upsert_values({"_id": "L1:a", "library_id": "L1"})
    assert 0 <= row["shuffle_key"] < 1
    stmt = scanner.image_upsert_stmt()
    # The upsert's conflict update leaves the key alone.
    assert "shuffle_key" not in str(stmt.compile()).split("ON CONFLICT")[1]


async def test_reshuffle_rerolls_in_chunks(client, seed, monkeypatch):
    monkeypatch.setattr(shuffle, "_CHUNK", 3)
    _seed_keyed(seed, n=10)
    before = _keys()
    assert await shuffle.reshuffle() == 10
    after = _keys()
    assert sum(after[i] != before[i] for i in before) >= 8
    assert all(0 <= k < 1 for k in after.values())


async def test_random_picks_from_a_workflow_family(client, seed):
    # Family W: two versions (s1, s2); s3 is another family's.
    seed("L1:a", gen={"workflow_sig": "s1"}, shuffle_key=0.1)
    seed("L1:b", gen={"workflow_sig": "s2"}, shuffle_key=0.2)
    seed("L1:c", gen={"workflow_sig": "s3"}, shuffle_key=0.3)
    seed("L1:d", shuffle_key=0.4)
    with db.sync_tx() as conn:
        for image_id, sig, wid in [
            ("L1:a", "s1", "W"),
            ("L1:b", "s2", "W"),
            ("L1:c", "s3", "X"),
        ]:
            conn.execute(
                sa.insert(t.image_gen_raw).values(
                    _id=image_id,
                    library_id="L1",
                    workflow_sig=sig,
                    raw={"workflow": {"id": wid, "nodes": []}},
                )
            )
    resp = await client.get("/images/random", params={"workflow": "W"})
    assert resp.status_code == 200
    assert {r["_id"] for r in resp.json()} == {"L1:a", "L1:b"}
