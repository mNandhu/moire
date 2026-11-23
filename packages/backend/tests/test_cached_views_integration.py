"""The cached views over images (filter facets, workflow signatures): a write
the user waits to see shows in the very next response, whatever the cache
held. Each test reads the view first, so a missing invalidation would serve
the cached answer."""

import time

import sqlalchemy as sa
from PIL import Image

from moire.database import db
from moire.database import schema as t
from moire.services.library import scanner
from moire.services.tags import sensitivity as tag_sensitivity


def _wait_scan(library_id: str, timeout: float = 20.0) -> None:
    th = scanner._scan_threads.get(library_id)
    if th is not None:
        th.join(timeout=timeout)
    deadline = time.time() + timeout
    while time.time() < deadline:
        with db.sync_conn() as conn:
            scanning = conn.execute(
                sa.select(t.libraries.c.scanning).where(t.libraries.c._id == library_id)
            ).scalar()
        if not scanning:
            return
        time.sleep(0.05)


async def _square(client, **params) -> int:
    rows = (await client.get("/images/sizes", params=params)).json()
    return next(r["count"] for r in rows if r["shape"] == "1:1")


async def _loras(client) -> dict:
    return {r["name"]: r["count"] for r in (await client.get("/images/loras")).json()}


async def test_a_scan_shows_in_the_sizes(client, tmp_path):
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    # No generation metadata: no reprojection follows to invalidate for it.
    Image.new("RGB", (8, 8)).save(lib_dir / "one.png")
    resp = await client.post("/libraries", json={"path": str(lib_dir)})
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)
    assert await _square(client) == 1
    assert await _square(client, library_id=lib_id) == 1

    Image.new("RGB", (8, 8)).save(lib_dir / "two.png")
    await client.post(f"/libraries/{lib_id}/rescan")
    _wait_scan(lib_id)
    assert await _square(client) == 2
    assert await _square(client, library_id=lib_id) == 2


async def test_quarantine_and_purge_leave_the_facets(client, seed):
    for name in ("a", "b", "c"):
        seed(f"L1:{name}.png", width=1024, height=1024)
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_loras),
            [{"image_id": f"L1:{n}.png", "name": "style_one"} for n in ("a", "b")],
        )
    assert await _square(client) == 3
    assert await _loras(client) == {"style_one": 2}

    await client.post("/images/L1:a.png/quarantine", json={"quarantined": True})
    assert await _square(client) == 2
    assert await _loras(client) == {"style_one": 1}
    assert await _square(client, quarantined=1) == 1

    await client.post("/images/L1:b.png/purge", json={"confirm": True})
    assert await _square(client) == 1
    assert await _loras(client) == {}


async def test_the_sensitivity_filter_changes_the_facets(client, seed):
    tag_sensitivity.ship_for_tests({"level_three_tag": 3})
    seed("L1:a.png", width=64, height=64, tags=("cat",), rating="general")
    seed("L1:b.png", width=64, height=64, tags=("cat", "prompt:level_three_tag"))
    assert await _square(client) == 2
    resp = await client.post("/sensitivity", json={"max_level": "sensitive"})
    assert resp.status_code == 200, resp.text
    assert await _square(client) == 1
    await client.post("/sensitivity", json={"max_level": None})
    assert await _square(client) == 2


async def _sig(client, sig="S1") -> dict:
    rows = (await client.get("/rules/signatures")).json()
    return next(r for r in rows if r["workflow_sig"] == sig)


def _seed_signature(seed):
    seed("L1:w.png", gen={"workflow_sig": "S1", "prompt": "p"}, thumb_key="k")
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id="L1:w.png",
                library_id="L1",
                workflow_sig="S1",
                raw={
                    "workflow": {
                        "id": "W1",
                        "nodes": [{"type": "KSampler"}, {"type": "SaveImage"}],
                    }
                },
            )
        )


async def test_a_ruleset_shows_in_the_signatures(client, seed):
    _seed_signature(seed)
    assert (await _sig(client))["has_ruleset"] is False
    resp = await client.put("/rules/S1", json={"fields": {}})
    assert resp.status_code == 200, resp.text
    assert (await _sig(client))["has_ruleset"] is True
    await client.delete("/rules/S1")
    assert (await _sig(client))["has_ruleset"] is False


async def test_a_family_name_shows_in_the_signatures(client, seed):
    _seed_signature(seed)
    first = await _sig(client)
    assert first["workflow_id"] == "W1" and first["workflow_name"] is None
    assert "sample_thumb_url" in first
    resp = await client.put("/rules/workflows/W1/name", json={"name": "Portraits"})
    assert resp.status_code == 200, resp.text
    assert (await _sig(client))["workflow_name"] == "Portraits"


async def test_an_imported_file_shows_in_the_signatures(client, seed):
    _seed_signature(seed)
    assert (await _sig(client))["file_name"] is None
    resp = await client.post(
        "/rules/workflow-files",
        json=[
            {
                "workflow_id": "W1",
                "filename": "portraits.json",
                "node_types": ["KSampler", "SaveImage"],
            }
        ],
    )
    assert resp.status_code == 200, resp.text
    assert (await _sig(client))["file_name"] == "portraits.json"


async def test_a_deleted_image_leaves_the_signatures(client, seed):
    _seed_signature(seed)
    seed("L1:v.png", gen={"workflow_sig": "S1", "prompt": "p"})
    assert (await _sig(client))["count"] == 2
    await client.post("/images/L1:v.png/purge", json={"confirm": True})
    assert (await _sig(client))["count"] == 1
