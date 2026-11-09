"""Tag index: cache staleness rules + that every tag writer dirties it.

Before the index owned its own invalidation this bug class was unreachable:
"writer X forgot to clear the cache" could only be observed through HTTP with a
real 30-second clock, which is why it was never tested and why three writers
silently skipped it.
"""

from __future__ import annotations

import asyncio

import pytest

from moire.services.tags import image_tags, tag_covers, tag_index


# --- Cache primitives (pure, no DB) -------------------------------------------


def test_invalidate_bumps_the_generation():
    before = tag_index.current_generation()
    tag_index.invalidate()
    assert tag_index.current_generation() == before + 1


class _Builder:
    """A build that counts its calls and, with ``gate``, waits to finish."""

    def __init__(self) -> None:
        self.calls = 0
        self.gate: asyncio.Event | None = None

    async def __call__(self) -> list[dict]:
        self.calls += 1
        n = self.calls
        if self.gate is not None:
            await self.gate.wait()
        return [{"_id": f"v{n}"}]


async def _settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_a_view_misses_once_the_generation_moved():
    build = _Builder()
    await tag_index.cached("views", "k", build)
    tag_index.invalidate()
    assert await tag_index.cached("views", "k", build) == [{"_id": "v2"}]


async def test_a_view_misses_once_its_ttl_lapsed(monkeypatch):
    build = _Builder()
    await tag_index.cached("views", "k", build)
    monkeypatch.setitem(tag_index._TTLS, "views", 0.0)
    assert await tag_index.cached("views", "k", build) == [{"_id": "v2"}]


async def test_a_build_is_not_kept_when_a_write_landed_mid_query():
    """The race the generation counter exists for: a write commits while the
    build's query runs, and its now-stale result must not be cached."""
    build = _Builder()
    build.gate = asyncio.Event()
    first = asyncio.create_task(tag_index.cached("views", "k", build))
    await _settle()
    tag_index.invalidate()  # writer commits mid-query
    build.gate.set()
    assert await first == [{"_id": "v1"}]
    assert tag_index._tags_cache == {}


async def test_a_soft_write_keeps_a_build_that_spanned_it():
    """A bulk job's write landing mid-build must not throw the build away (it
    did for every image, so the tag list was never cached during a job)."""
    build = _Builder()
    build.gate = asyncio.Event()
    first = asyncio.create_task(tag_index.cached("views", "k", build))
    await _settle()
    tag_index.invalidate_soft()
    build.gate.set()
    await first
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    assert build.calls == 1


async def test_a_derived_value_lags_soft_writes_only_inside_the_window(
    monkeypatch,
):
    build = _Builder()
    await tag_index.cached("derived", "d", build)
    tag_index.invalidate_soft()
    assert tag_index.peek("derived", "d") == [{"_id": "v1"}]
    assert await tag_index.cached("derived", "d", build) == [{"_id": "v1"}]
    assert build.calls == 1
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)
    await tag_index.cached("derived", "d", build)
    await _settle()
    assert build.calls == 2


# --- cached(): stale while it rebuilds, one build at a time --------------------


async def test_cached_builds_once_then_serves_from_memory():
    build = _Builder()
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    assert build.calls == 1


async def test_concurrent_misses_share_one_build():
    build = _Builder()
    build.gate = asyncio.Event()
    waiting = [
        asyncio.create_task(tag_index.cached("views", "k", build)) for _ in range(3)
    ]
    await _settle()
    build.gate.set()
    assert await asyncio.gather(*waiting) == [[{"_id": "v1"}]] * 3
    assert build.calls == 1


async def test_soft_stale_view_is_served_while_one_build_replaces_it(monkeypatch):
    build = _Builder()
    await tag_index.cached("views", "k", build)
    tag_index.invalidate_soft()
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)
    build.gate = asyncio.Event()
    # Answered at once with the old view, twice, with one rebuild started.
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    build.gate.set()
    await _settle()
    assert build.calls == 2
    assert await tag_index.cached("views", "k", build) == [{"_id": "v2"}]


async def test_a_view_too_old_is_rebuilt_before_answering(monkeypatch):
    build = _Builder()
    await tag_index.cached("views", "k", build)
    tag_index.invalidate_soft()
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)
    monkeypatch.setattr(tag_index, "_STALE_MAX_SECONDS", 0.0)
    assert await tag_index.cached("views", "k", build) == [{"_id": "v2"}]


async def test_a_hard_write_is_never_answered_from_older_data():
    """A request after a hard write must not get the view, nor join a build,
    from before it."""
    build = _Builder()
    await tag_index.cached("views", "k", build)
    build.gate = asyncio.Event()
    tag_index.invalidate_soft()
    tag_index.invalidate()
    early = asyncio.create_task(tag_index.cached("views", "k", build))
    await _settle()
    tag_index.invalidate()  # lands while the build above runs
    late = asyncio.create_task(tag_index.cached("views", "k", build))
    await _settle()
    build.gate.set()
    assert await early == [{"_id": "v2"}]
    assert await late == [{"_id": "v3"}]


async def test_a_build_spanning_soft_writes_ages_from_when_it_began(monkeypatch):
    """Its age counts from its read, not its store: a write it may have
    missed still makes it stale once the window passes."""
    build = _Builder()
    build.gate = asyncio.Event()
    first = asyncio.create_task(tag_index.cached("views", "k", build))
    await _settle()
    tag_index.invalidate_soft()  # lands mid-build
    build.gate.set()
    assert await first == [{"_id": "v1"}]
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    await _settle()
    assert build.calls == 2


async def test_a_failed_background_build_keeps_the_old_view(monkeypatch):
    build = _Builder()
    await tag_index.cached("views", "k", build)
    tag_index.invalidate_soft()
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)

    async def broken() -> list[dict]:
        raise RuntimeError("db gone")

    assert await tag_index.cached("views", "k", broken) == [{"_id": "v1"}]
    await _settle()
    # Not asked again at once (a busy database): served stale meanwhile.
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    await _settle()
    assert build.calls == 1
    monkeypatch.setattr(tag_index, "_RETRY_AFTER_FAILURE_SECONDS", 0.0)
    assert await tag_index.cached("views", "k", build) == [{"_id": "v1"}]
    await _settle()
    assert await tag_index.cached("views", "k", build) == [{"_id": "v2"}]


async def test_a_failed_build_is_logged_once(monkeypatch, caplog):
    """A waiter gets the error raised (the request logs it); only a build
    nobody awaited is logged here."""

    async def broken() -> list[dict]:
        raise RuntimeError("db gone")

    with pytest.raises(RuntimeError):
        await tag_index.cached("views", "k", broken)
    await _settle()
    assert "failed" not in caplog.text

    build = _Builder()
    await tag_index.cached("views", "k", build)
    tag_index.invalidate_soft()
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)
    await tag_index.cached("views", "k", broken)
    await _settle()
    assert caplog.text.count("tag view build k failed") == 1


async def test_valid_rejects_a_value_built_from_old_inputs():
    build = _Builder()
    await tag_index.cached("derived", "k", build)
    got = await tag_index.cached(
        "derived", "k", build, valid=lambda v: v[0]["_id"] != "v1"
    )
    assert got == [{"_id": "v2"}]


async def test_valid_rejects_a_build_under_way_from_old_inputs():
    """A caller with new inputs (a reloaded vocabulary) that joins a build
    begun from the old ones gets a build of its own."""
    build = _Builder()
    build.gate = asyncio.Event()
    old = asyncio.create_task(tag_index.cached("derived", "k", build))
    await _settle()
    new = asyncio.create_task(
        tag_index.cached("derived", "k", build, valid=lambda v: v[0]["_id"] != "v1")
    )
    await _settle()
    build.gate.set()
    assert await old == [{"_id": "v1"}]
    assert await new == [{"_id": "v2"}]


async def test_a_build_from_a_stale_input_is_no_fresher_than_it(monkeypatch):
    """A view built from another cached view served stale takes that view's
    age, so lag doesn't stack: it is rebuilt once the input is."""
    inner = _Builder()
    await tag_index.cached("views", "inner", inner)
    tag_index.invalidate_soft()
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)
    inner.gate = asyncio.Event()
    outer_calls = 0

    async def outer() -> list[dict]:
        nonlocal outer_calls
        outer_calls += 1
        return await tag_index.cached("views", "inner", inner)

    assert await tag_index.cached("views", "outer", outer) == [{"_id": "v1"}]
    # Stamped with the stale input's read: served stale, rebuilt again.
    assert await tag_index.cached("views", "outer", outer) == [{"_id": "v1"}]
    await _settle()
    assert outer_calls == 2
    inner.gate.set()
    await _settle()
    assert tag_index.peek("views", "inner") == [{"_id": "v2"}]


async def test_stale_false_rebuilds_before_answering(monkeypatch):
    build = _Builder()
    await tag_index.cached("derived", "n", build)
    tag_index.invalidate_soft()
    monkeypatch.setattr(tag_index, "_SOFT_STALE_SECONDS", 0.0)
    assert await tag_index.cached("derived", "n", build, stale=False) == [{"_id": "v2"}]


async def test_a_build_from_an_older_generation_is_not_kept():
    """``gen``: inputs the caller read before a hard write make a value that
    is answered but not cached."""
    gen = tag_index.current_generation()
    tag_index.invalidate()
    build = _Builder()
    assert await tag_index.cached("derived", "k", build, gen=gen) == [{"_id": "v1"}]
    assert tag_index.peek("derived", "k") is None


def test_peek_never_builds():
    assert tag_index.peek("views", "nothing") is None
    assert tag_index._inflight == {}


async def test_cancel_builds_stops_the_ones_under_way():
    build = _Builder()
    build.gate = asyncio.Event()
    waiting = asyncio.create_task(tag_index.cached("views", "k", build))
    await _settle()
    await tag_index.cancel_builds()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert tag_index._inflight == {}


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
async def test_bulk_replace_ai_lags_until_the_run_ends(temp_db, client, seed):
    """An AI job's writes may lag in the tag views; its end catches them up."""
    seed("L1:a.jpg", tags=("cat",))
    assert await _counts(client) == {"cat": 1}

    await image_tags.replace_ai(
        "L1:a.jpg", ai_tags=["dog"], ai_meta={}, rating="general", bulk=True
    )
    assert await _counts(client) == {"cat": 1}

    image_tags.end_bulk_writes()
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

    samples = await tag_covers.samples_for_tag("cat", 3)
    ids = [row["_id"] for row in samples]

    assert ids[0] == "L1:c.jpg"
    assert len(ids) == len(set(ids)) == 3


@pytest.mark.asyncio
async def test_samples_take_one_image_per_batch_while_they_can(temp_db, seed):
    # Batch A has six look-alike images; B, C and D one each.
    for i in range(6):
        seed(f"L1:a{i}.jpg", tags=("cat",), gen={"group_id": "A"})
    for g in "BCD":
        seed(f"L1:{g}.jpg", tags=("cat",), gen={"group_id": g})

    ids = [row["_id"] for row in await tag_covers.samples_for_tag("cat", 4)]
    assert sum(i.startswith("L1:a") for i in ids) == 1
    assert {"L1:B.jpg", "L1:C.jpg", "L1:D.jpg"} <= set(ids)


@pytest.mark.asyncio
async def test_samples_fill_from_a_batch_again_when_short(temp_db, seed):
    for i in range(3):
        seed(f"L1:a{i}.jpg", tags=("cat",), gen={"group_id": "A"})
    seed("L1:b.jpg", tags=("cat",))

    ids = [row["_id"] for row in await tag_covers.samples_for_tag("cat", 4)]
    assert len(set(ids)) == 4


@pytest.mark.asyncio
async def test_samples_are_capped_at_per(temp_db, seed):
    for name in "abcde":
        seed(f"L1:{name}.jpg", tags=("cat",))

    assert len(await tag_covers.samples_for_tag("cat", 2)) == 2


@pytest.mark.asyncio
async def test_route_decorates_samples_with_the_thumb_url(client, seed):
    seed("L1:a.jpg", tags=("cat",))

    resp = await client.get("/tags/samples", params={"tags": ["cat"], "per": 1})

    assert resp.json()["cat"][0]["thumb_url"].startswith(
        "/api/v1/images/L1%3Aa.jpg/thumb?v="
    )


@pytest.mark.asyncio
async def test_reprojection_batch_dirties_the_index(temp_db, seed):
    """Reprojection owns its own sync transaction and runs on scanner threads, so
    it invalidates per committed batch rather than per image."""
    from moire.services.metadata import reproject

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
    # A survivor: a scan that finds no files at all keeps everything.
    Image.new("RGB", (8, 8)).save(lib_dir / "survivor.png", "PNG")

    resp = await client.post("/libraries", json={"path": str(lib_dir)})
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)

    await client.post(f"/tags/apply/{lib_id}:doomed.png", json=["keeper"])
    assert await _counts(client) == {"manual:keeper": 1}  # warms the cache

    doomed.unlink()
    await client.post(f"/libraries/{lib_id}/rescan")
    _wait_scan(lib_id)

    assert await _counts(client) == {}
