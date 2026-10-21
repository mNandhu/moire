"""The first-run flag: fresh databases open on the welcome page, existing
ones never do, and finishing or skipping setup sticks."""

from __future__ import annotations

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t


async def test_fresh_database_is_pending(client):
    r = await client.get("/onboarding")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "pending"
    assert body["version"]
    assert body["data_dir"]


async def test_database_with_libraries_counts_as_set_up(client):
    async with db.async_tx() as conn:
        await conn.execute(
            sa.insert(t.libraries).values(
                _id="L1", path="/x", name="x", indexed_count=0
            )
        )
    assert (await client.get("/onboarding")).json()["status"] == "done"


async def test_status_round_trip(client):
    for status in ("skipped", "done", "pending"):
        r = await client.put("/onboarding", json={"status": status})
        assert r.status_code == 200
        assert (await client.get("/onboarding")).json()["status"] == status


async def test_stored_status_wins_over_library_check(client):
    await client.put("/onboarding", json={"status": "pending"})
    async with db.async_tx() as conn:
        await conn.execute(
            sa.insert(t.libraries).values(
                _id="L1", path="/x", name="x", indexed_count=0
            )
        )
    assert (await client.get("/onboarding")).json()["status"] == "pending"


async def test_unknown_status_rejected(client):
    r = await client.put("/onboarding", json={"status": "later"})
    assert r.status_code == 422
