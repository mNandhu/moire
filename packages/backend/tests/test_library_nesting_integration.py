"""A library inside another library's folder: the folder is the inner
library's alone. Real disk scans, as in test_scan_reproject_integration."""

import os
from urllib.parse import quote

import pytest
import sqlalchemy as sa
from PIL import Image

from moire.database import db
from moire.database import schema as t
from moire.services import library_nesting

from test_scan_reproject_integration import _wait_scan

pytestmark = pytest.mark.asyncio


def _png(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8)).save(path, "PNG")


def _tree(root):
    _png(root / "a.png")
    _png(root / "inner" / "b.png")
    _png(root / "inner" / "deep" / "c.png")


async def _add(client, path):
    resp = await client.post("/libraries", json={"path": str(path)})
    assert resp.status_code == 200, resp.text
    lib_id = resp.json()["_id"]
    _wait_scan(lib_id)
    return lib_id


async def _ids(library_id):
    async with db.async_conn() as conn:
        rows = await conn.execute(
            sa.select(t.images.c._id).where(t.images.c.library_id == library_id)
        )
        return {r._id for r in rows}


async def _lib(library_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.libraries).where(t.libraries.c._id == library_id)
            )
        ).first()


async def test_an_outer_library_skips_a_library_inside_it(client, tmp_path):
    _tree(tmp_path / "out")
    inner = await _add(client, tmp_path / "out" / "inner")
    outer = await _add(client, tmp_path / "out")

    assert await _ids(outer) == {f"{outer}:a.png"}
    assert await _ids(inner) == {
        f"{inner}:b.png",
        f"{inner}:{os.path.join('deep', 'c.png')}",
    }
    assert (await _lib(outer)).indexed_count == 1


async def test_adding_a_library_inside_takes_its_files_and_their_tags(client, tmp_path):
    _tree(tmp_path / "out")
    outer = await _add(client, tmp_path / "out")
    copy = f"{outer}:{os.path.join('inner', 'b.png')}"
    assert copy in await _ids(outer)
    # The user curated the outer library's copy.
    q = quote(copy, safe="")
    assert (await client.post(f"/tags/apply/{q}", json=["keeper"])).status_code == 200
    assert (
        await client.post(f"/images/{q}/score", json={"score": 4})
    ).status_code == 200
    assert (
        await client.post(f"/images/{q}/rating", json={"rating": "general"})
    ).status_code == 200
    await client.post("/tags/thumbnail/keeper", json={"image_id": copy})

    inner = await _add(client, tmp_path / "out" / "inner")

    assert await _ids(outer) == {f"{outer}:a.png"}
    assert (await _lib(outer)).indexed_count == 1
    mine = f"{inner}:b.png"
    async with db.async_conn() as conn:
        row = (
            await conn.execute(sa.select(t.images).where(t.images.c._id == mine))
        ).first()
        pin = (
            await conn.execute(
                sa.select(t.tag_meta.c.thumb_image_id).where(
                    t.tag_meta.c.tag == "keeper"
                )
            )
        ).scalar()
        tag_rows = {
            r.tag
            for r in await conn.execute(
                sa.select(t.image_tags.c.tag).where(t.image_tags.c.image_id == mine)
            )
        }
    assert "manual:keeper" in row.tags and "manual:keeper" in tag_rows
    assert row.has_tags is True
    assert row.score == 4
    assert row.rating == "general"
    assert pin == mine


async def test_removing_the_inner_library_hands_its_folder_back(client, tmp_path):
    _tree(tmp_path / "out")
    inner = await _add(client, tmp_path / "out" / "inner")
    outer = await _add(client, tmp_path / "out")
    assert len(await _ids(outer)) == 1

    await client.delete(f"/libraries/{inner}")
    _wait_scan(outer)

    assert len(await _ids(outer)) == 3


async def test_a_copy_waits_for_the_inner_library_and_goes_with_its_file(
    temp_db, seed, tmp_path
):
    """Copies the inner library hasn't indexed keep their tags until it has;
    once it has finished, a copy of a deleted file is dropped."""
    out, inner = tmp_path / "out", tmp_path / "out" / "inner"
    _png(inner / "kept.png")
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries),
            [
                {"_id": "O", "path": str(out), "name": "o"},
                {"_id": "I", "path": str(inner), "name": "i", "last_scanned": None},
            ],
        )
    seed("O:inner/kept.png", library_id="O", tags=("manual:x",))
    seed("O:inner/gone.png", library_id="O", tags=("manual:x",))
    with db.sync_tx() as conn:
        for i, name in (("O:inner/kept.png", "kept"), ("O:inner/gone.png", "gone")):
            conn.execute(
                sa.update(t.images)
                .where(t.images.c._id == i)
                .values(path=str(inner / f"{name}.png"))
            )

    assert library_nesting.adopt_nested_copies() == 0  # inner never scanned
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.libraries)
            .where(t.libraries.c._id == "I")
            .values(last_scanned="x")
        )
    # The deleted file's copy goes; the one on disk waits for the inner row.
    assert library_nesting.adopt_nested_copies() == 1
    assert await _ids("O") == {"O:inner/kept.png"}


def test_folder_helpers():
    root = library_nesting.path_key("/a/b")
    assert library_nesting.is_inside(library_nesting.path_key("/a/b/c"), root)
    assert not library_nesting.is_inside(library_nesting.path_key("/a/bc"), root)
    assert not library_nesting.is_inside(root, root)
    assert library_nesting.skip_dirs("/a", ["b", "bc"], [root]) == ["bc"]
    assert library_nesting.under_nested(
        {"1": "/a/b/x.png", "2": "/a/bx.png", "3": None}, [root]
    ) == {"1"}
