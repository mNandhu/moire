"""Versioned thumbnail URLs: `v` follows the thumbnail file; with it a
thumbnail is kept a year, without it the browser revalidates."""

import re
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image as PILImage

from moire.services import storage_fs, thumb_version


def _webp() -> bytes:
    buf = BytesIO()
    PILImage.new("RGB", (40, 60), (20, 90, 200)).save(buf, format="WEBP")
    return buf.getvalue()


async def _url(client, image_id: str = "L1:a.png") -> str:
    feed = (await client.get("/images")).json()
    return next(r["thumb_url"] for r in feed if r["_id"] == image_id)


def _webp_of(colour) -> bytes:
    buf = BytesIO()
    PILImage.new("RGB", (40, 60), colour).save(buf, format="WEBP")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_url_follows_the_thumbnail_file(client, seed):
    key = storage_fs.put_thumb("L1", "L1:a.png", _webp())
    seed("L1:a.png", thumb_key=key, mtime=100.0)
    seed("L1:b.png", mtime=100.0)
    first = await _url(client)
    assert "/images/L1%3Aa.png/thumb?v=" in first
    assert await _url(client) == first
    # No thumbnail yet: version 0 until one is written.
    assert (await _url(client, "L1:b.png")).endswith("?v=0")

    # A rescan making the same bytes leaves the file and the URL alone.
    path = storage_fs.thumb_path(key)
    before = path.stat().st_mtime_ns
    storage_fs.put_thumb("L1", "L1:a.png", _webp())
    assert path.stat().st_mtime_ns == before
    assert await _url(client) == first

    # A rebuilt thumbnail (an edited file, new settings) gets a new URL.
    storage_fs.put_thumb("L1", "L1:a.png", _webp_of((1, 2, 3)))
    assert await _url(client) != first
    # Everywhere the same: the id-only lookup agrees with the feed.
    got = (await client.get("/images/L1:a.png/thumb-url")).json()
    assert got["thumb_url"] == await _url(client)
    doc = (await client.get("/images/L1:a.png")).json()
    assert doc["thumb_url"] == await _url(client)


@pytest.mark.asyncio
async def test_lists_carry_versioned_urls(client, seed):
    storage_fs.put_thumb("L1", "L1:a.png", _webp())
    seed("L1:a.png", tags=("cat", "frieren"), mtime=1.0)
    want = await thumb_version.urls(["L1:a.png"])
    url = want["L1:a.png"]
    assert "?v=" in url and not url.endswith("?v=0")

    samples = (await client.get("/tags/samples", params={"tags": "cat"})).json()
    assert samples["cat"][0]["thumb_url"] == url
    browse = (await client.get("/tags/browse")).json()
    assert {r["thumb_url"] for r in browse} == {url}
    detail = (await client.get("/tags/detail", params={"tag": "cat"})).json()
    assert detail["cover_url"] == url
    groups = (await client.get("/images/groups")).json()
    assert all("?v=" in g["thumb_url"] for g in groups)


def test_nothing_else_builds_a_thumb_url():
    """Every thumbnail URL comes from `thumb_version`, so none ships without
    its version."""
    src = Path(thumb_version.__file__).parents[1]
    # `images/{<id>}/thumb` with no `:path`: a URL, not the route.
    built = re.compile(r"images/\{[^}:]*\}/thumb")
    builders = [
        p.relative_to(src).as_posix()
        for p in src.rglob("*.py")
        if built.search(p.read_text(encoding="utf-8"))
    ]
    assert builders == ["services/thumb_version.py"]


# -- Caching -------------------------------------------------------------------


@pytest.fixture
def thumbed(temp_db, seed):
    key = storage_fs.put_thumb("L1", "L1:a.png", _webp())
    seed("L1:a.png", thumb_key=key, mtime=1.0)


@pytest.mark.asyncio
async def test_a_versioned_url_is_kept_and_a_bare_one_revalidated(client, thumbed):
    kept = await client.get("/images/L1:a.png/thumb", params={"v": "abc"})
    assert "immutable" in kept.headers["cache-control"]
    small = await client.get(
        "/images/L1:a.png/thumb", params={"v": "abc", "size": "small"}
    )
    assert "immutable" in small.headers["cache-control"]

    bare = await client.get("/images/L1:a.png/thumb")
    assert bare.headers["cache-control"] == "no-cache"
    etag = bare.headers["etag"]

    again = await client.get(
        "/images/L1:a.png/thumb", headers={"If-None-Match": f'W/{etag}, "x"'}
    )
    assert again.status_code == 304
    assert again.headers["etag"] == etag
    assert again.content == b""

    changed = await client.get(
        "/images/L1:a.png/thumb", headers={"If-None-Match": '"stale"'}
    )
    assert changed.status_code == 200
    assert changed.content == bare.content


@pytest.mark.asyncio
async def test_an_original_is_revalidated_not_kept(client, temp_db, seed, tmp_path):
    # Its URL has no version: a file replaced at the same path must show.
    import os

    import sqlalchemy as sa

    from moire.database import db
    from moire.database import schema as t

    f = tmp_path / "a.png"
    f.write_bytes(b"one")
    seed("L1:a.png")
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images).where(t.images.c._id == "L1:a.png").values(path=str(f))
        )

    first = await client.get("/images/L1:a.png/file")
    assert first.headers["cache-control"] == "no-cache"
    etag = first.headers["etag"]
    same = await client.get("/images/L1:a.png/file", headers={"If-None-Match": etag})
    assert same.status_code == 304 and same.headers["cache-control"] == "no-cache"

    f.write_bytes(b"two!")
    os.utime(f, (1e9, 1e9))
    new = await client.get("/images/L1:a.png/file", headers={"If-None-Match": etag})
    assert new.status_code == 200 and new.content == b"two!"
