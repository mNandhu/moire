"""Versioned thumbnail URLs: `v` follows the file's mtime and its library's
last full-scan stamp; with it a thumbnail is kept a year, without it the
browser revalidates."""

import re
from io import BytesIO
from pathlib import Path

import pytest
import sqlalchemy as sa
from PIL import Image as PILImage

from moire.database import db
from moire.database import schema as t
from moire.services import storage_fs, thumb_version


def _webp() -> bytes:
    buf = BytesIO()
    PILImage.new("RGB", (40, 60), (20, 90, 200)).save(buf, format="WEBP")
    return buf.getvalue()


async def _url(client, image_id: str = "L1:a.png") -> str:
    feed = (await client.get("/images")).json()
    return next(r["thumb_url"] for r in feed if r["_id"] == image_id)


@pytest.mark.asyncio
async def test_url_follows_the_file_and_its_librarys_scan(client, seed):
    seed("L1:a.png", tags=("cat",), mtime=100.0)
    seed("L2:b.png", tags=("cat",), mtime=100.0)
    first = await _url(client)
    assert "/images/L1%3Aa.png/thumb?v=" in first
    assert await _url(client) == first

    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images).where(t.images.c._id == "L1:a.png").values(mtime=200.0)
        )
    edited = await _url(client)
    assert edited != first

    other = await _url(client, "L2:b.png")
    thumb_version.set_stamp("L1", "1024/webp/q85/r2/c3")
    assert await _url(client) != edited
    assert await _url(client, "L2:b.png") == other


@pytest.mark.asyncio
async def test_lists_carry_versioned_urls(client, seed):
    seed("L1:a.png", tags=("cat", "frieren"), mtime=1.0)
    want = await thumb_version.urls(["L1:a.png"])
    url = want["L1:a.png"]
    assert "?v=" in url

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
