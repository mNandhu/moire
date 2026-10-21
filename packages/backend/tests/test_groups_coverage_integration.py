"""Integration tests for the batch-collapsed grouped view, AI coverage counts,
and the models filter list."""

import pytest

pytestmark = pytest.mark.asyncio


async def test_groups_collapse_to_newest_representative(client, seed):
    # Three members of one batch + one standalone image.
    seed("L1:g1", gen={"group_id": "G", "workflow_sig": "s"})
    seed("L1:g2", gen={"group_id": "G", "workflow_sig": "s"})
    seed("L1:g3", gen={"group_id": "G", "workflow_sig": "s"})
    seed("L1:solo", gen={"workflow_sig": "s"})

    resp = await client.get("/images/groups")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    by_id = {r["_id"]: r for r in rows}

    # The batch folds into one entry: newest member (_id desc) is the rep, count 3.
    assert "L1:g3" in by_id
    assert by_id["L1:g3"]["group_count"] == 3
    # The standalone image stands alone with count 1.
    assert by_id["L1:solo"]["group_count"] == 1
    # Two visible entries total (the batch + the solo), not four.
    assert len(rows) == 2


async def test_groups_order_by_newest_member_time(client, seed):
    # The batch's newest member is by time, not id; batches sort by it too.
    seed("L1:z_old", mtime=100, gen={"group_id": "G", "workflow_sig": "s"})
    seed("L1:a_new", mtime=300, gen={"group_id": "G", "workflow_sig": "s"})
    seed("L2:solo", library_id="L2", mtime=200, gen={"workflow_sig": "s"})
    rows = (await client.get("/images/groups")).json()
    assert [(r["_id"], r["group_count"]) for r in rows] == [
        ("L1:a_new", 2),
        ("L2:solo", 1),
    ]


async def test_groups_project_the_same_columns_as_the_flat_feed(client, seed):
    """The grid draws the same triage state in both gallery views.

    `list_groups` built its result dicts from a hand-written key list, so a
    column added to FEED_COLUMNS reached `/images` and silently skipped
    `/images/groups`: the grouped view rendered tiles with no rating dot, no
    quarantine badge and no untagged marker.
    """
    seed("L1:g1", gen={"group_id": "G", "workflow_sig": "s"})
    seed(
        "L1:g2",
        gen={"group_id": "G", "workflow_sig": "s"},
        tags=("1girl",),
        score=4,
        rating="explicit",
    )

    flat = (await client.get("/images")).json()
    grouped = (await client.get("/images/groups")).json()
    assert flat and grouped

    # Every key the flat feed offers is present on the grouped representative.
    assert set(flat[0]) - {"thumb_url"} <= set(grouped[0])

    # And the values actually arrive, rather than arriving as None.
    rep = next(r for r in grouped if r["_id"] == "L1:g2")
    assert rep["score"] == 4
    assert rep["rating"] == "explicit"
    assert rep["has_ai_tags"] is True
    assert rep["quarantined"] is False


async def test_groups_span_page_order_desc(client, seed):
    seed("L1:a", gen={"group_id": "GA", "workflow_sig": "s"})
    seed("L1:b", gen={"group_id": "GB", "workflow_sig": "s"})
    resp = await client.get("/images/groups")
    ids = [r["_id"] for r in resp.json()]
    assert ids == ["L1:b", "L1:a"]  # rep _id desc


async def test_ai_coverage_per_library_counts(client, seed):
    seed("L1:a", tags=("1girl",), library_id="L1")  # ai-tagged
    seed("L1:b", tags=("manual:fav",), library_id="L1")  # not ai-tagged
    seed("L1:c", library_id="L1")  # no tags at all
    seed("L2:a", tags=("1girl",), library_id="L2")
    seed("L2:q", tags=("1girl",), library_id="L2", quarantined=True)  # excluded

    resp = await client.get("/ai/coverage")
    data = resp.json()
    assert data["total"] == 4  # quarantined excluded
    assert data["ai_tagged"] == 2
    assert data["untagged"] == 2
    assert data["no_tags"] == 1
    per = {r["library_id"]: r for r in data["per_library"]}
    assert per["L1"] == {"library_id": "L1", "total": 3, "ai_tagged": 1}
    assert per["L2"] == {"library_id": "L2", "total": 1, "ai_tagged": 1}


async def test_models_list_counts_and_sorted(client, seed):
    seed("L1:a", gen={"model": "sdxl", "workflow_sig": "s"})
    seed("L1:b", gen={"model": "sdxl", "workflow_sig": "s"})
    seed("L1:c", gen={"model": "pony", "workflow_sig": "s"})
    seed("L1:d", gen=None)  # no model -> excluded

    resp = await client.get("/images/models")
    rows = resp.json()
    assert rows[0] == {"model": "sdxl", "count": 2}  # most frequent first
    assert {"model": "pony", "count": 1} in rows
    assert all(r["model"] is not None for r in rows)


async def test_tag_untagged_skips_quarantined_like_coverage(client, seed, monkeypatch):
    from moire.services.ai_jobs import get_ai_job_manager

    seed("L1:a", tags=("1girl",))  # ai-tagged: skipped
    seed("L1:b")  # untagged: queued
    seed("L1:q", quarantined=True)  # untagged but quarantined: skipped

    queued: list[list[str]] = []

    async def fake_enqueue(self, *, ids, force=False):
        queued.append(ids)
        return None

    monkeypatch.setattr(type(get_ai_job_manager()), "enqueue", fake_enqueue)
    await get_ai_job_manager().enqueue_untagged(limit=10)

    assert queued == [["L1:b"]]
    cov = (await client.get("/ai/coverage")).json()
    assert cov["untagged"] == len(queued[0])


async def test_stats_counts_images_per_local_day_and_quarantine(client, seed):
    import time

    now = time.time()
    # Two on one day, one a day later, one far outside the window.
    day0 = (now // 86400 - 3) * 86400 + 3600  # 01:00 UTC, three days ago
    seed("L1:a", mtime=day0)
    seed("L1:b", mtime=day0 + 60, quarantined=True)
    seed("L2:c", library_id="L2", mtime=day0 + 86400)
    seed("L1:old", mtime=now - 400 * 86400)
    seed("L1:none")

    body = (await client.get("/images/stats", params={"days": 30})).json()
    assert [r["count"] for r in body["activity"]] == [2, 1]
    assert body["quarantined"] == 1

    # Two hours west of UTC, 01:00 UTC is still the previous local day.
    west = (
        await client.get("/images/stats", params={"days": 30, "tz": "Etc/GMT+2"})
    ).json()
    utc_days = [r["day"] for r in body["activity"]]
    assert [r["day"] for r in west["activity"]] != utc_days
    assert [r["count"] for r in west["activity"]] == [2, 1]


async def test_stats_days_follow_dst_and_half_hour_zones(client, seed):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    berlin = ZoneInfo("Europe/Berlin")
    # 23:30 local in winter (UTC+1) and in summer (UTC+2): both stay on their
    # own local date, whatever offset applies when the page is viewed.
    winter = datetime(2026, 1, 15, 23, 30, tzinfo=berlin).timestamp()
    summer = datetime(2026, 7, 15, 23, 30, tzinfo=berlin).timestamp()
    seed("L1:w", mtime=winter)
    seed("L1:s", mtime=summer)
    body = (
        await client.get("/images/stats", params={"days": 3660, "tz": "Europe/Berlin"})
    ).json()
    assert [r["day"] for r in body["activity"]] == ["2026-01-15", "2026-07-15"]

    # India is UTC+5:30: 18:40 UTC is already 00:10 the next day there.
    seed("L1:i", mtime=datetime(2026, 3, 1, 18, 40, tzinfo=ZoneInfo("UTC")).timestamp())
    body = (
        await client.get("/images/stats", params={"days": 3660, "tz": "Asia/Kolkata"})
    ).json()
    assert "2026-03-02" in [r["day"] for r in body["activity"]]


async def test_stats_rejects_unknown_zone(client):
    resp = await client.get("/images/stats", params={"tz": "Mars/Olympus"})
    assert resp.status_code == 422


async def test_stats_zone_aliases_and_offset_fallback(client, seed):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    # Chrome reports India as the legacy alias; tzdata knows it.
    seed("L1:i", mtime=datetime(2026, 3, 1, 18, 40, tzinfo=ZoneInfo("UTC")).timestamp())
    alias = await client.get(
        "/images/stats", params={"days": 3660, "tz": "Asia/Calcutta"}
    )
    assert alias.status_code == 200
    assert [r["day"] for r in alias.json()["activity"]] == ["2026-03-02"]
    # An unknown zone with the viewer's offset degrades instead of failing.
    fallback = await client.get(
        "/images/stats", params={"days": 3660, "tz": "Mars/Olympus", "tz_offset": 330}
    )
    assert [r["day"] for r in fallback.json()["activity"]] == ["2026-03-02"]
