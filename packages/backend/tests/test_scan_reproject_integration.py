"""End-to-end integration for the two highest-risk write subsystems that the
other tests stub past: a real disk scan (sync, multithreaded → SQLite) and
reprojection (the sole writer of the promoted gen_* columns + image_gen_terms +
prompt: tags). Without these, the model/pterms feed filters would be unverified."""

import time

import pytest
import sqlalchemy as sa
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from src.database import db
from src.database import schema as t
from src.services import reproject, scanner

pytestmark = pytest.mark.asyncio


def _write_png(path, **text_chunks):
    meta = PngInfo()
    for k, v in text_chunks.items():
        meta.add_text(k, v)
    Image.new("RGB", (8, 8)).save(path, "PNG", pnginfo=meta)


async def _img(image_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
        ).first()


# --- reprojection (sync, direct) ---------------------------------------------


async def test_reproject_writes_gen_columns_terms_and_prompt_tags(temp_db, seed):
    image_id = "L1:art.png"
    seed(image_id, tags=("1girl",))  # existing AI tag must survive reprojection
    # Stash the captured raw the scanner would have written.
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=None,
                raw={
                    "source": "a1111",
                    "parameters": "masterpiece, 1girl\nSteps: 20, Model: sdxl, Seed: 7",
                },
            )
        )

    updated = reproject.reproject_library("L1")
    assert updated == 1

    row = await _img(image_id)
    # Promoted gen.* columns the feed filters read (the ONLY writer is reproject).
    assert row.gen_model == "sdxl"
    assert row.gen_prompt is not None
    assert row.gen is not None
    # Derived prompt-term rows (the pterms filter source).
    async with db.async_conn() as conn:
        terms = {
            r.term
            for r in (
                await conn.execute(
                    sa.select(t.image_gen_terms.c.term).where(
                        t.image_gen_terms.c.image_id == image_id
                    )
                )
            ).fetchall()
        }
    assert terms  # non-empty; tokens extracted from the prompt
    # prompt: tags mirrored into the tag array, AI tag preserved, flags resynced.
    assert "1girl" in row.tags
    assert any(tag.startswith("prompt:") for tag in row.tags)
    assert row.has_ai_tags is True
    assert row.has_prompt_tags is True


async def test_reproject_model_filter_works_after_real_reprojection(client, seed):
    image_id = "L1:art.png"
    seed(image_id)
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=None,
                raw={
                    "source": "a1111",
                    "parameters": "a cat\nSteps: 20, Model: pony, Seed: 1",
                },
            )
        )
    reproject.reproject_library("L1")

    # The model filter (reads gen_model) now returns the image. End to end.
    resp = await client.get("/images", params={"model": "pony"})
    assert [it["_id"] for it in resp.json()] == [image_id]


# --- full disk scan (sync, multithreaded) ------------------------------------


def _wait_scan(library_id: str, timeout: float = 20.0) -> None:
    th = scanner._scan_threads.get(library_id)
    if th is not None:
        th.join(timeout=timeout)
    # Belt-and-suspenders: also wait for the scanning flag to clear.
    deadline = time.time() + timeout
    while time.time() < deadline:
        with db.sync_conn() as conn:
            scanning = (
                conn.execute(
                    sa.select(t.libraries.c.scanning).where(
                        t.libraries.c._id == library_id
                    )
                )
            ).scalar()
        if not scanning:
            return
        time.sleep(0.05)


async def test_full_scan_indexes_images_and_rescan_preserves_tag_state(
    client, tmp_path
):
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    _write_png(lib_dir / "plain.png")
    _write_png(
        lib_dir / "gen.png",
        parameters="masterpiece\nSteps: 20, Model: sdxl",
    )

    # Add the library through the API. This kicks off the real background scan.
    resp = await client.post("/libraries", json={"path": str(lib_dir)})
    assert resp.status_code == 200, resp.text
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)

    # Both files indexed, with insert-time tag-state seeded.
    feed = await client.get("/images", params={"library_id": lib_id})
    ids = {it["_id"] for it in feed.json()}
    assert ids == {f"{lib_id}:plain.png", f"{lib_id}:gen.png"}

    target = f"{lib_id}:plain.png"
    row = await _img(target)
    assert row.thumb_key is not None  # thumbnail written to FS
    assert row.has_tags is False  # fresh: no curatable tags yet

    # Simulate curation, then rescan: ON CONFLICT must NOT reset the manual tag.
    await client.post(f"/tags/apply/{target}", json=["keeper"])
    await client.post(f"/libraries/{lib_id}/rescan")
    _wait_scan(lib_id)

    row = await _img(target)
    assert "manual:keeper" in row.tags  # survived the rescan upsert
    assert row.has_tags is True


async def test_full_scan_captures_a1111_exif_from_a_real_jpeg(client, tmp_path):
    """The JPEG/WebP capture path end to end: EXIF UserComment -> image_gen_raw
    -> reprojected gen.* columns. Every prior scan test wrote PNGs, so this
    container had never been exercised by a scan."""
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    params = "masterpiece, 1girl\nSteps: 20, Model: sdxl, Seed: 7"
    im = Image.new("RGB", (16, 16))
    exif = im.getexif()
    exif[0x9286] = b"UNICODE\x00" + params.encode("utf-16-be")
    im.save(lib_dir / "shot.jpg", "JPEG", exif=exif.tobytes())

    resp = await client.post("/libraries", json={"path": str(lib_dir)})
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)

    image_id = f"{lib_id}:shot.jpg"
    async with db.async_conn() as conn:
        raw = (
            await conn.execute(
                sa.select(t.image_gen_raw).where(t.image_gen_raw.c._id == image_id)
            )
        ).first()
    assert raw is not None, "EXIF-carried generation data was not captured"
    assert raw.raw["source"] == "a1111"

    # Post-scan reprojection runs on its own thread (scanner frees the scan
    # slot first), so the scan finishing doesn't mean gen.* is written yet.
    row = await _img(image_id)
    deadline = time.time() + 20
    while row.gen_model is None and time.time() < deadline:
        time.sleep(0.05)
        row = await _img(image_id)
    assert row.gen_model == "sdxl"
    assert "1girl" in (row.gen_prompt or "")


async def test_queued_scan_uses_the_path_the_library_has_when_it_starts(
    client, tmp_path
):
    """A scan waiting for a slot must not walk the path captured at enqueue
    time: moving the library meanwhile is a no-op rescan request (one is
    already queued), so the queued scan is the only one that will run."""
    old_dir, new_dir = tmp_path / "old", tmp_path / "new"
    old_dir.mkdir()
    new_dir.mkdir()
    _write_png(old_dir / "stale.png")
    _write_png(new_dir / "fresh.png")

    held = 0
    while scanner._scan_slots.acquire(blocking=False):
        held += 1
    try:
        resp = await client.post("/libraries", json={"path": str(old_dir)})
        lib_id = resp.json()["_id"]
        resp = await client.patch(f"/libraries/{lib_id}", json={"path": str(new_dir)})
        assert resp.status_code == 200, resp.text
    finally:
        for _ in range(held):
            scanner._scan_slots.release()
    _wait_scan(lib_id)

    feed = await client.get("/images", params={"library_id": lib_id})
    assert {it["_id"] for it in feed.json()} == {f"{lib_id}:fresh.png"}


async def test_rescan_skips_unchanged_files_and_rebuilds_on_change(
    client, tmp_path, monkeypatch
):
    """A rescan opens only files whose size/mtime moved or whose thumbnail is
    gone, and a change to the thumbnail settings rebuilds everything."""
    import os

    from src.core.config import settings
    from src.services.storage_fs import delete_thumb

    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    for name in ("a.png", "b.png", "c.png"):
        _write_png(lib_dir / name)

    resp = await client.post("/libraries", json={"path": str(lib_dir)})
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)

    opened: list[str] = []
    real_make = scanner._make_thumb_bytes

    def counting_make(path):
        opened.append(path.name)
        return real_make(path)

    reprojected: list[str] = []
    monkeypatch.setattr(scanner, "_make_thumb_bytes", counting_make)
    monkeypatch.setattr(
        reproject, "reproject_library_async", lambda lid: reprojected.append(lid)
    )

    async def rescan() -> None:
        opened.clear()
        reprojected.clear()
        await client.post(f"/libraries/{lib_id}/rescan")
        _wait_scan(lib_id)

    # Nothing changed: no file is opened, nothing is reprojected, and the
    # library still counts all three.
    await rescan()
    assert opened == []
    assert reprojected == []
    async with db.async_conn() as conn:
        count = (
            await conn.execute(
                sa.select(t.libraries.c.indexed_count).where(
                    t.libraries.c._id == lib_id
                )
            )
        ).scalar()
    assert count == 3

    # A touched file and a file whose thumbnail vanished are rebuilt.
    st = os.stat(lib_dir / "a.png")
    os.utime(lib_dir / "a.png", (st.st_atime, st.st_mtime + 10))
    delete_thumb((await _img(f"{lib_id}:b.png")).thumb_key)
    await rescan()
    assert sorted(opened) == ["a.png", "b.png"]
    assert reprojected == [lib_id]
    assert (await _img(f"{lib_id}:a.png")).mtime == st.st_mtime + 10

    # New thumbnail settings rebuild every file once.
    monkeypatch.setattr(settings, "thumb_max_size", 640)
    await rescan()
    assert sorted(opened) == ["a.png", "b.png", "c.png"]
    await rescan()
    assert opened == []


async def test_thumbnails_are_served_without_gzip(client, tmp_path):
    """Images are already compressed: gzip only adds CPU (and drops
    Content-Length), so the middleware must pass them through."""
    import os

    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    Image.frombytes("RGB", (256, 256), os.urandom(256 * 256 * 3)).save(
        lib_dir / "noise.png"
    )
    resp = await client.post("/libraries", json={"path": str(lib_dir)})
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)

    resp = await client.get(
        f"/images/{lib_id}:noise.png/thumb", headers={"Accept-Encoding": "gzip"}
    )
    assert resp.status_code == 200
    assert len(resp.content) > 1000  # above the middleware's minimum size
    assert "content-encoding" not in resp.headers
    assert int(resp.headers["content-length"]) == len(resp.content)


async def test_moved_library_rescan_updates_paths(client, tmp_path):
    """Ids are relative to the root, so after a move every unchanged file
    still matches its row; the rescan must still point rows at the new path."""
    old_dir, new_dir = tmp_path / "old", tmp_path / "new"
    old_dir.mkdir()
    _write_png(old_dir / "a.png")
    resp = await client.post("/libraries", json={"path": str(old_dir)})
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)

    old_dir.rename(new_dir)  # keeps size and mtime
    resp = await client.patch(f"/libraries/{lib_id}", json={"path": str(new_dir)})
    assert resp.status_code == 200, resp.text
    _wait_scan(lib_id)

    assert (await _img(f"{lib_id}:a.png")).path == str(new_dir / "a.png")


async def test_toggling_positive_only_reprojects(client, monkeypatch):
    """Rescans only re-derive changed files, so the switch must reproject."""
    calls: list[str] = []
    monkeypatch.setattr(reproject, "reproject_all_async", lambda: calls.append("all"))
    current = (await client.get("/ai/settings")).json()["prompt_positive_only"]

    await client.post("/ai/settings", json={"prompt_positive_only": current})
    assert calls == []
    await client.post("/ai/settings", json={"prompt_positive_only": not current})
    assert calls == ["all"]
