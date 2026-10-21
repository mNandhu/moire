"""Tag index: cache staleness rules + that every tag writer dirties it.

Before the index owned its own invalidation this bug class was unreachable:
"writer X forgot to clear the cache" could only be observed through HTTP with a
real 30-second clock, which is why it was never tested and why three writers
silently skipped it.
"""

from __future__ import annotations

import pytest

from moire.services import image_tags, tag_index


# --- Cache primitives (pure, no DB) -------------------------------------------


def test_invalidate_bumps_the_generation():
    before = tag_index.current_generation()
    tag_index.invalidate()
    assert tag_index.current_generation() == before + 1


def test_read_misses_when_the_generation_moved():
    cache: dict = {}
    gen = tag_index.current_generation()
    tag_index._store(cache, "k", gen, [{"_id": "a"}])
    assert tag_index._read(cache, "k", ttl=999) == [{"_id": "a"}]

    tag_index.invalidate()
    assert tag_index._read(cache, "k", ttl=999) is None


def test_read_misses_once_the_ttl_lapsed():
    cache: dict = {}
    gen = tag_index.current_generation()
    tag_index._store(cache, "k", gen, [{"_id": "a"}])
    assert tag_index._read(cache, "k", ttl=0.0) is None


def test_store_is_discarded_when_a_write_landed_mid_query():
    """The race the generation counter exists for: a reader captures the
    generation, a writer invalidates while the query is still running, and the
    reader must *not* cache its now-stale result."""
    cache: dict = {}
    gen = tag_index.current_generation()  # reader starts
    tag_index.invalidate()  # writer commits mid-query
    tag_index._store(cache, "k", gen, [{"_id": "stale"}])  # reader finishes
    assert cache == {}


# --- Writers dirty the index (integration) ------------------------------------


async def _counts(client) -> dict[str, int]:
    resp = await client.get("/tags", params={"include_manual": True})
    assert resp.status_code == 200
    return {row["_id"]: row["count"] for row in resp.json()}


@pytest.mark.asyncio
async def test_applying_a_manual_tag_dirties_a_warm_index(client, seed):
    seed("L1:a.jpg", tags=("cat",))
    assert await _counts(client) == {"cat": 1}  # warms the cache

    await client.post("/tags/apply/L1:a.jpg", json=["favourite"])

    # Without invalidation this still reads {"cat": 1} for the full 30s TTL.
    assert await _counts(client) == {"cat": 1, "manual:favourite": 1}


@pytest.mark.asyncio
async def test_removing_a_tag_dirties_a_warm_index(client, seed):
    seed("L1:a.jpg", tags=("cat", "dog"))
    assert await _counts(client) == {"cat": 1, "dog": 1}

    await client.post("/tags/remove/L1:a.jpg", json=["dog"])

    assert await _counts(client) == {"cat": 1}


@pytest.mark.asyncio
async def test_clear_ai_all_dirties_a_warm_index(client, seed):
    """`clear_ai_all` lives outside the router entirely; it could never have
    reached the old module-private cache."""
    seed("L1:a.jpg", tags=("cat", "manual:keep"))
    assert await _counts(client) == {"cat": 1, "manual:keep": 1}

    resp = await client.post("/ai/clear-ai-tags")
    assert resp.status_code == 200

    assert await _counts(client) == {"manual:keep": 1}


@pytest.mark.asyncio
async def test_replace_ai_dirties_a_warm_index(temp_db, client, seed):
    """The AI job worker's write path, exercised directly; it runs on the job
    queue, not through any tags route."""
    seed("L1:a.jpg", tags=("cat",))
    assert await _counts(client) == {"cat": 1}

    await image_tags.replace_ai(
        "L1:a.jpg", ai_tags=["dog"], ai_meta={}, rating="general"
    )

    assert await _counts(client) == {"dog": 1}


@pytest.mark.asyncio
async def test_pinning_a_tag_thumbnail_dirties_the_mosaic(client, seed):
    seed("L1:a.jpg", tags=("cat",))
    seed("L1:b.jpg", tags=("cat",))

    first = await client.get("/tags/samples", params={"tags": ["cat"], "per": 1})
    assert first.status_code == 200

    resp = await client.post("/tags/thumbnail/cat", json={"image_id": "L1:b.jpg"})
    assert resp.status_code == 200

    after = await client.get("/tags/samples", params={"tags": ["cat"], "per": 1})
    assert [row["_id"] for row in after.json()["cat"]] == ["L1:b.jpg"]


# --- Mosaic fill rules --------------------------------------------------------


@pytest.mark.asyncio
async def test_pinned_thumbnail_leads_and_is_not_duplicated(temp_db, client, seed):
    seed("L1:a.jpg", tags=("cat",))
    seed("L1:b.jpg", tags=("cat",))
    seed("L1:c.jpg", tags=("cat",))
    await client.post("/tags/thumbnail/cat", json={"image_id": "L1:c.jpg"})

    samples = await tag_index.samples_for_tag("cat", 3)
    ids = [row["_id"] for row in samples]

    assert ids[0] == "L1:c.jpg"
    assert len(ids) == len(set(ids)) == 3


@pytest.mark.asyncio
async def test_samples_are_capped_at_per(temp_db, seed):
    for name in "abcde":
        seed(f"L1:{name}.jpg", tags=("cat",))

    assert len(await tag_index.samples_for_tag("cat", 2)) == 2


@pytest.mark.asyncio
async def test_route_decorates_samples_with_the_thumb_url(client, seed):
    seed("L1:a.jpg", tags=("cat",))

    resp = await client.get("/tags/samples", params={"tags": ["cat"], "per": 1})

    assert resp.json()["cat"][0]["thumb_url"] == "/api/v1/images/L1%3Aa.jpg/thumb"


@pytest.mark.asyncio
async def test_reprojection_batch_dirties_the_index(temp_db, seed):
    """Reprojection owns its own sync transaction and runs on scanner threads, so
    it invalidates per committed batch rather than per image."""
    from moire.services import reproject

    seed("L1:a.jpg", tags=("cat",))
    before = tag_index.current_generation()

    reproject._flush_batch([("L1:a.jpg", {"prompt_terms": ["masterpiece"]})])

    assert tag_index.current_generation() > before


# --- Deletions cascade away join rows, so they move the counts too -------------


@pytest.mark.asyncio
async def test_purging_an_image_dirties_a_warm_index(client, seed, tmp_path):
    seed("L1:a.jpg", tags=("cat",))
    seed("L1:b.jpg", tags=("dog",))
    assert await _counts(client) == {"cat": 1, "dog": 1}

    resp = await client.post("/images/L1:a.jpg/purge", json={"confirm": True})
    assert resp.status_code == 200

    assert await _counts(client) == {"dog": 1}


@pytest.mark.asyncio
async def test_removing_a_library_dirties_a_warm_index(client, seed):
    seed("L1:a.jpg", library_id="L1", tags=("cat",))
    seed("L2:b.jpg", library_id="L2", tags=("dog",))
    assert await _counts(client) == {"cat": 1, "dog": 1}

    resp = await client.delete("/libraries/L1")
    assert resp.status_code == 200

    assert await _counts(client) == {"dog": 1}


@pytest.mark.asyncio
async def test_scan_reconcile_dirties_the_index(client, tmp_path):
    """A real scan: reconciling away a file that vanished from disk deletes the
    image, whose `image_tags` rows cascade, so the counts move even though the
    scan never wrote a tag itself. The reconcile owns its own sync transaction."""
    from PIL import Image

    from test_scan_reproject_integration import _wait_scan

    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    doomed = lib_dir / "doomed.png"
    Image.new("RGB", (8, 8)).save(doomed, "PNG")

    resp = await client.post("/libraries", json={"path": str(lib_dir)})
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)

    await client.post(f"/tags/apply/{lib_id}:doomed.png", json=["keeper"])
    assert await _counts(client) == {"manual:keeper": 1}  # warms the cache

    doomed.unlink()
    await client.post(f"/libraries/{lib_id}/rescan")
    _wait_scan(lib_id)

    assert await _counts(client) == {}
