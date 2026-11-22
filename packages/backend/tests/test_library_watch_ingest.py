"""Integration tests for the watcher's ingest/remove path.

The functions it calls: one file in -> one row upserted without touching the
rest of the library, and one file gone -> exactly that row (and its thumb)
removed. Then the watch thread itself (`_run_watch`, fed through its queue):
a burst is ingested as one batch with one tag-view invalidation, a file still
being written waits for a later pass, and a burst of deletes goes together.
"""

import threading
import time

import pytest
import sqlalchemy as sa
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from moire.core.config import settings
from moire.database import db
from moire.database import schema as t
from moire.services.library import scan_incremental, scanner
from moire.services.library import watch as library_watch
from moire.services.metadata import reproject
from moire.services.tags import index as tag_index


async def _img(image_id: str):
    async with db.async_conn() as conn:
        return (
            await conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
        ).first()


async def test_ingest_single_file_adds_one_row_without_touching_others(
    temp_db, seed, tmp_path
):
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    seed("L1:other.jpg", library_id="L1", tags=("cat",))

    new_path = lib_dir / "new.png"
    Image.new("RGB", (4, 4)).save(new_path, "PNG")

    ok = scan_incremental.ingest_single_file("L1", lib_dir, new_path)
    assert ok is True

    row = await _img("L1:new.png")
    assert row is not None
    assert row.width == 4 and row.height == 4
    assert row.tags == []  # fresh insert, not the untouched sibling's tags

    # The pre-existing image is untouched (no whole-library reconciliation ran).
    other = await _img("L1:other.jpg")
    assert other is not None
    assert other.tags == ["cat"]


async def test_ingest_single_file_refreshes_metadata_on_modify(temp_db, tmp_path):
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    p = lib_dir / "a.png"
    Image.new("RGB", (4, 4)).save(p, "PNG")
    assert scan_incremental.ingest_single_file("L1", lib_dir, p) is True

    Image.new("RGB", (16, 16)).save(p, "PNG")
    assert scan_incremental.ingest_single_file("L1", lib_dir, p) is True

    row = await _img("L1:a.png")
    assert row.width == 16 and row.height == 16


async def test_ingest_updates_a_backslash_stored_row_in_place(client, seed, tmp_path):
    """A row an older scan stored as ``L1:sub\\a.png`` is the same image as
    the watcher's ``L1:sub/a.png``: updated under its stored id, not joined
    by a second row, and the library count left as it was."""
    with db.sync_tx() as conn:
        conn.execute(sa.insert(t.libraries).values(_id="L1", indexed_count=1))
    seed("L1:sub\\a.png", tags=("manual:keep",), width=4, height=4)
    lib_dir = tmp_path / "lib"
    (lib_dir / "sub").mkdir(parents=True)
    p = lib_dir / "sub" / "a.png"
    Image.new("RGB", (16, 16)).save(p, "PNG")

    assert scan_incremental.ingest_single_file("L1", lib_dir, p) is True

    async with db.async_conn() as conn:
        ids = (await conn.execute(sa.select(t.images.c._id))).scalars().all()
        count = (
            await conn.execute(sa.select(t.libraries.c.indexed_count))
        ).scalar_one()
    assert ids == ["L1:sub\\a.png"]
    row = await _img("L1:sub\\a.png")
    assert row.width == 16 and row.tags == ["manual:keep"]
    assert count == 1
    # Its thumbnail is the one this ingest wrote.
    resp = await client.get("/images/L1:sub%5Ca.png/thumb")
    assert resp.status_code == 200, resp.text


async def test_remove_single_image_deletes_only_that_row(temp_db, seed):
    seed("L1:keep.jpg", tags=("cat",))
    seed("L1:gone.jpg", tags=("dog",), thumb_key=None)

    scan_incremental.remove_single_image("L1", "L1:gone.jpg")

    assert await _img("L1:gone.jpg") is None
    keep = await _img("L1:keep.jpg")
    assert keep is not None and keep.tags == ["cat"]


async def test_remove_single_image_is_a_noop_for_unknown_id(temp_db):
    # Should not raise even though the row was never indexed.
    scan_incremental.remove_single_image("L1", "L1:never-existed.jpg")


def _wait(pred, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def watch_thread(monkeypatch, temp_db):
    """Runs `_run_watch` for library L1 on a temp root; records ingest
    batches, tag-view invalidations and post-scan calls."""
    monkeypatch.setattr(settings, "watch_stability_window_ms", 100)
    monkeypatch.setattr(scanner, "is_scanning", lambda _id: False)
    monkeypatch.setattr(scanner, "nudge_auto_tag", lambda: None)
    calls = {"batches": [], "invalidate": 0, "after_scan": []}
    real_ingest = scan_incremental.ingest_files

    def ingest(lib, root, paths, **kw):
        calls["batches"].append(sorted(p.name for p in paths))
        return real_ingest(lib, root, paths, **kw)

    def invalidate(*_a, **_kw):
        calls["invalidate"] += 1

    monkeypatch.setattr(scan_incremental, "ingest_files", ingest)
    monkeypatch.setattr(tag_index, "invalidate", invalidate)
    monkeypatch.setattr(
        reproject,
        "reproject_ids_async",
        lambda ids, **_kw: calls["after_scan"].append(set(ids)),
    )
    with db.sync_tx() as conn:
        conn.execute(sa.insert(t.libraries).values(_id="L1", indexed_count=0))
    threads = []

    def start(root):
        w = library_watch._Watch("L1", root)
        th = threading.Thread(target=library_watch._run_watch, args=(w,))
        th.start()
        threads.append((w, th))
        return w

    yield start, calls
    for w, th in threads:
        w.stop_event.set()
        w.queue.put(None)
        th.join(timeout=5)


def _ids():
    with db.sync_conn() as conn:
        return sorted(conn.execute(sa.select(t.images.c._id)).scalars())


def _indexed_count():
    with db.sync_conn() as conn:
        return conn.execute(sa.select(t.libraries.c.indexed_count)).scalar_one()


def test_a_burst_is_ingested_as_one_batch(watch_thread, tmp_path):
    start, calls = watch_thread
    root = tmp_path / "lib"
    root.mkdir()
    names = [f"f{i}.png" for i in range(12)]
    meta = PngInfo()
    meta.add_text("parameters", "a cat\nSteps: 20, Sampler: Euler, Seed: 1")
    for i, n in enumerate(names):
        # Two of them carry generation data to derive.
        Image.new("RGB", (4, 4)).save(root / n, "PNG", pnginfo=meta if i < 2 else None)
    w = start(root)
    w.queue.put({(library_watch.Change.added, str(root / n)) for n in names})

    assert _wait(lambda: len(_ids()) == len(names))
    assert calls["batches"] == [sorted(names)]
    assert calls["invalidate"] == 1
    assert _indexed_count() == len(names)
    # One reprojection, of just the raws written.
    assert calls["after_scan"] == [{"L1:f0.png", "L1:f1.png"}]


def test_a_growing_file_waits_until_it_holds_still(watch_thread, tmp_path):
    start, calls = watch_thread
    root = tmp_path / "lib"
    root.mkdir()
    done = root / "done.png"
    Image.new("RGB", (4, 4)).save(done, "PNG")
    growing = root / "growing.png"
    Image.new("RGB", (8, 8)).save(growing, "PNG")
    w = start(root)
    w.queue.put(
        {
            (library_watch.Change.added, str(done)),
            (library_watch.Change.added, str(growing)),
        }
    )
    # Keep the second file changing across several windows, as a writer
    # still streaming bytes would; no new event arrives for it.
    with growing.open("ab") as f:

        def grow():
            # Faster than the window, so it never holds still for one.
            f.write(b"\0" * 64)
            f.flush()
            time.sleep(0.03)

        deadline = time.monotonic() + 10
        while "L1:done.png" not in _ids() and time.monotonic() < deadline:
            grow()
        for _ in range(8):
            grow()
        assert _ids() == ["L1:done.png"]
    assert _wait(lambda: len(_ids()) == 2)
    assert calls["batches"] == [["done.png"], ["growing.png"]]


def test_a_burst_of_deletes_goes_together(watch_thread, tmp_path, seed):
    start, calls = watch_thread
    root = tmp_path / "lib"
    root.mkdir()
    for i in range(5):
        seed(f"L1:gone{i}.png", library_id="L1", thumb_key=None)
    seed("L1:keep.png", library_id="L1", thumb_key=None)
    (root / "keep.png").write_bytes(b"x")
    with db.sync_tx() as conn:
        conn.execute(sa.update(t.libraries).values(indexed_count=6))
    w = start(root)
    w.queue.put(
        {(library_watch.Change.deleted, str(root / f"gone{i}.png")) for i in range(5)}
    )

    assert _wait(lambda: _ids() == ["L1:keep.png"])
    assert _wait(lambda: calls["invalidate"] == 1)
    assert _indexed_count() == 1
    assert calls["batches"] == []


def test_a_row_already_gone_is_not_counted_off(watch_thread, seed, monkeypatch):
    # The UI deleted "gone" between the watcher resolving the ids and its
    # delete transaction: only the row actually removed comes off the count.
    seed("L1:a.png", library_id="L1", thumb_key=None)
    seed("L1:b.png", library_id="L1", thumb_key=None)
    with db.sync_tx() as conn:
        conn.execute(sa.update(t.libraries).values(indexed_count=2))
    monkeypatch.setattr(
        scan_incremental.image_tags, "resolve_image_id_sync", lambda _c, i: i
    )
    scan_incremental.remove_images("L1", ["L1:a.png", "L1:gone.png"])
    assert _ids() == ["L1:b.png"]
    assert _indexed_count() == 1


def test_files_held_back_by_a_scan_are_ingested_after_it(
    watch_thread, tmp_path, monkeypatch
):
    start, calls = watch_thread
    root = tmp_path / "lib"
    root.mkdir()
    Image.new("RGB", (4, 4)).save(root / "a.png", "PNG")
    w = start(root)
    w.queue.put({(library_watch.Change.added, str(root / "a.png"))})
    assert _wait(lambda: _ids() == ["L1:a.png"])

    # A scan starts while a changed file is pending: it waits (polling once
    # a window, not in a busy loop) and is ingested once the scan ends.
    scan = {"on": True, "checks": 0}

    def is_scanning(_id):
        scan["checks"] += 1
        return scan["on"]

    Image.new("RGB", (8, 8)).save(root / "b.png", "PNG")
    monkeypatch.setattr(scanner, "is_scanning", lambda _id: False)
    w.queue.put({(library_watch.Change.added, str(root / "b.png"))})
    time.sleep(0.02)  # noted as pending before the scan starts
    monkeypatch.setattr(scanner, "is_scanning", is_scanning)
    time.sleep(0.6)
    assert _ids() == ["L1:a.png"]
    assert scan["checks"] < 15
    scan["on"] = False
    assert _wait(lambda: _ids() == ["L1:a.png", "L1:b.png"])
    assert calls["batches"] == [["a.png"], ["b.png"]]
