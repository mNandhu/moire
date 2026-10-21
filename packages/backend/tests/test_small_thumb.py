"""The small thumbnail tier: `/images/{id}/thumb?size=small` makes a small copy
beside the thumbnail on first ask, keeps it, and drops it with the thumbnail."""

import os
from io import BytesIO

import pytest
from PIL import Image as PILImage

from moire.services import storage_fs


def _webp(w: int, h: int) -> bytes:
    buf = BytesIO()
    PILImage.new("RGB", (w, h), (200, 80, 40)).save(buf, format="WEBP")
    return buf.getvalue()


@pytest.fixture
def thumbed(temp_db, seed):
    key = storage_fs.put_thumb("L1", "L1:dir/a.png", _webp(512, 768))
    seed("L1:dir/a.png", thumb_key=key)
    return key


def _small(key: str):
    return storage_fs._safe_path(storage_fs.small_key(key))


def test_small_key_sits_beside_the_thumb():
    assert storage_fs.small_key("L1/L1_dir/a.png.webp") == "L1/L1_dir/a.png.small.webp"


@pytest.mark.asyncio
async def test_small_is_made_once_on_first_ask(client, thumbed):
    full = await client.get("/images/L1:dir%2Fa.png/thumb")
    assert PILImage.open(BytesIO(full.content)).size == (512, 768)
    assert not _small(thumbed).exists()

    r = await client.get("/images/L1:dir%2Fa.png/thumb", params={"size": "small"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    assert PILImage.open(BytesIO(r.content)).size == (256, 384)
    made = _small(thumbed).stat().st_mtime_ns

    await client.get("/images/L1:dir%2Fa.png/thumb", params={"size": "small"})
    assert _small(thumbed).stat().st_mtime_ns == made


@pytest.mark.asyncio
async def test_small_keeps_a_thumb_already_small(client, temp_db, seed):
    key = storage_fs.put_thumb("L1", "L1:b.png", _webp(120, 90))
    seed("L1:b.png", thumb_key=key)
    r = await client.get("/images/L1:b.png/thumb", params={"size": "small"})
    assert PILImage.open(BytesIO(r.content)).size == (120, 90)
    assert not _small(key).exists()


@pytest.mark.asyncio
async def test_unreadable_thumb_serves_as_itself(client, temp_db, seed, monkeypatch):
    key = storage_fs.put_thumb("L1", "L1:c.png", b"not an image")
    seed("L1:c.png", thumb_key=key)
    r = await client.get("/images/L1:c.png/thumb", params={"size": "small"})
    assert r.status_code == 200
    assert r.content == b"not an image"

    # Not tried again until the thumbnail changes.
    opened = []
    real_open = storage_fs.PILImage.open
    monkeypatch.setattr(
        storage_fs.PILImage, "open", lambda *a: opened.append(a) or real_open(*a)
    )
    await client.get("/images/L1:c.png/thumb", params={"size": "small"})
    assert opened == []


@pytest.mark.asyncio
async def test_unwritable_copy_serves_the_thumb_uncached(client, thumbed, monkeypatch):
    def full_disk(*a, **k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(storage_fs, "_write_atomic", full_disk)
    r = await client.get("/images/L1:dir%2Fa.png/thumb", params={"size": "small"})
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"
    assert PILImage.open(BytesIO(r.content)).size == (512, 768)


@pytest.mark.asyncio
async def test_head_with_size_makes_nothing(client, thumbed):
    r = await client.head("/images/L1:dir%2Fa.png/thumb", params={"size": "small"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    assert not _small(thumbed).exists()

    storage_fs.delete_thumb(thumbed)
    r = await client.head("/images/L1:dir%2Fa.png/thumb", params={"size": "small"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_unknown_size_is_refused(client, thumbed):
    r = await client.get("/images/L1:dir%2Fa.png/thumb", params={"size": "huge"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_rewritten_or_deleted_thumb_takes_its_small_copy(client, thumbed):
    await client.get("/images/L1:dir%2Fa.png/thumb", params={"size": "small"})
    assert _small(thumbed).exists()

    # A rescan writes the thumbnail again.
    storage_fs.put_thumb("L1", "L1:dir/a.png", _webp(768, 512))
    assert not _small(thumbed).exists()
    r = await client.get("/images/L1:dir%2Fa.png/thumb", params={"size": "small"})
    assert PILImage.open(BytesIO(r.content)).size == (384, 256)

    storage_fs.delete_thumb(thumbed)
    assert not _small(thumbed).exists()
    assert storage_fs.thumb_path(thumbed) is None


def test_small_is_remade_when_the_thumb_changes(temp_db, thumbed):
    small = storage_fs.small_thumb_path(thumbed)
    src = storage_fs.thumb_path(thumbed)
    assert small.stat().st_mtime_ns == src.stat().st_mtime_ns
    # Something other than put_thumb replaced the thumbnail after the copy.
    src.write_bytes(_webp(300, 300))
    os.utime(src, ns=(1, small.stat().st_mtime_ns + 1))
    again = storage_fs.small_thumb_path(thumbed)
    assert PILImage.open(again).size == (256, 256)


def test_copy_from_a_replaced_thumb_is_not_kept(temp_db, thumbed):
    """A copy encoded from the old thumbnail lands after a rescan replaced it:
    it carries the old mtime, so it is made again."""
    old = storage_fs.small_thumb_path(thumbed).stat().st_mtime_ns
    storage_fs.put_thumb("L1", "L1:dir/a.png", _webp(768, 512))
    src = storage_fs.thumb_path(thumbed)
    os.utime(src, ns=(1, old + 1_000_000))
    late = storage_fs._safe_path(storage_fs.small_key(thumbed))
    storage_fs._write_atomic(late, _webp(10, 10), mtime_ns=old)
    again = storage_fs.small_thumb_path(thumbed)
    assert PILImage.open(again).size == (384, 256)
