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
