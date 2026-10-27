"""Integration tests for the watcher's single-file ingest/remove path.

`library_watch` itself just wires filesystem events to these two scanner
functions (plus a stability check that's pure timing, not worth a slow test).
The behavior worth locking down lives in the functions it calls: one file in
-> one row upserted without touching the rest of the library, and one file
gone -> exactly that row (and its thumb) removed.
"""

import pytest
import sqlalchemy as sa
from PIL import Image

from moire.database import db
from moire.database import schema as t
from moire.services import scan_incremental

pytestmark = pytest.mark.asyncio


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
