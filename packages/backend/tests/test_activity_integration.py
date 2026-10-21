"""The background activity list the UI's indicator reads."""

import threading

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import activity, face_detect


async def _items(client):
    resp = await client.get("/activity")
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


@pytest.mark.asyncio
async def test_idle_is_empty(client):
    assert await _items(client) == []


@pytest.mark.asyncio
async def test_counts_work_that_ended_between_polls(client):
    before = (await client.get("/activity")).json()["ended"].get("delete", 0)
    with activity.track("delete", library_id="x"):
        pass
    assert (await client.get("/activity")).json()["ended"]["delete"] == before + 1


@pytest.mark.asyncio
async def test_scans_and_tracked_work_show_while_they_run(client, temp_db):
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries),
            [
                {
                    "_id": "A",
                    "path": "/a",
                    "name": "a",
                    "scanning": True,
                    "scan_total": 10,
                    "scan_done": 4,
                },
                {
                    "_id": "Q",
                    "path": "/q",
                    "name": "q",
                    "scanning": True,
                    "scan_total": 0,
                    "scan_done": 0,
                },
            ],
        )
    with activity.track("delete", library_id="A") as task:
        task.advance(2)
        items = await _items(client)
        libs = {i["_id"]: i for i in (await client.get("/libraries")).json()}
    assert libs["A"]["deleting"] is True and libs["Q"]["deleting"] is False
    by_kind = {(i["kind"], i.get("library_id")): i for i in items}
    assert by_kind[("scan", "A")]["done"] == 4 and by_kind[("scan", "A")]["total"] == 10
    assert by_kind[("scan", "Q")]["total"] is None  # queued: nothing counted yet
    assert by_kind[("delete", "A")]["done"] == 2
    # Gone once the work ends, however it ends.
    with pytest.raises(RuntimeError):
        with activity.track("reproject"):
            raise RuntimeError
    assert not activity.snapshot()


def test_registry_is_safe_across_threads():
    def work():
        for _ in range(200):
            with activity.track("reproject") as task:
                task.add_total(1)
                task.advance()

    threads = [threading.Thread(target=work) for _ in range(4)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert activity.snapshot() == []


def test_face_progress_counts_the_current_batch(monkeypatch):
    monkeypatch.setattr(face_detect, "_pending", {"x", "y"})
    monkeypatch.setattr(face_detect, "_batch", 5)
    assert face_detect.progress() == (3, 5)
    monkeypatch.setattr(face_detect, "_pending", set())
    assert face_detect.progress() == (0, 0)


def test_reprojecting_ids_never_moves_the_bar_back(monkeypatch):
    from moire.services import reproject

    seen: list[tuple[int, int]] = []

    def fake_where(where, *, task, count_total, **_kw):
        assert count_total is False
        # Only half of each chunk has raw data to derive.
        for _ in range(250):
            task.advance()
            seen.append((task.done, task.total))
        return 250

    monkeypatch.setattr(reproject, "_reproject_where", fake_where)
    with activity.track("reproject") as task:
        reproject.reproject_ids([f"i{n}" for n in range(1000)], task=task)
        assert (task.done, task.total) == (1000, 1000)
    pcts = [d / t for d, t in seen]
    assert pcts == sorted(pcts) and all(t == 1000 for _, t in seen)


def test_a_download_counts_the_files_already_sized():
    from moire.api.activity import _download

    files = [
        {"name": "model.onnx", "downloaded": 100, "total": 400},
        {"name": "selected_tags.csv", "downloaded": 0, "total": None},
    ]
    item = _download("k", "model_download", {"status": "downloading", "files": files})
    assert (item["done"], item["total"]) == (100, 400)
    assert _download("k", "model_download", {"status": "done", "files": files}) is None
    unsized = _download("k", "model_download", {"status": "downloading", "files": []})
    assert "total" not in unsized
