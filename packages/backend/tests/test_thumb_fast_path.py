"""The thumbnail route's fast path: no DB lookup, the id gives the key. Its
guard against hostile ids, its fallback to the DB, and its size bound."""

from io import BytesIO

import pytest
from PIL import Image as PILImage

from moire.api import image_media
from moire.services.library import storage_fs


def _webp() -> bytes:
    buf = BytesIO()
    PILImage.new("RGB", (40, 60), (20, 90, 200)).save(buf, format="WEBP")
    return buf.getvalue()


@pytest.fixture
def thumbed(temp_db, seed):
    key = storage_fs.put_thumb("L1", "L1:dir/a.png", _webp())
    seed("L1:dir/a.png", thumb_key=key)
    return key


@pytest.mark.asyncio
async def test_served_without_asking_the_db(client, thumbed, monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("DB lookup on the hot path")

    monkeypatch.setattr(image_media, "_find_image_doc", boom)
    r = await client.get("/images/L1:dir%2Fa.png/thumb", params={"v": "x"})
    assert r.status_code == 200
    assert r.content == _webp()
    assert r.headers["content-type"] == "image/webp"
    assert "immutable" in r.headers["cache-control"]
    assert r.headers["content-length"] == str(len(_webp()))
    etag = r.headers["etag"]
    again = await client.get(
        "/images/L1:dir%2Fa.png/thumb", headers={"If-None-Match": etag}
    )
    assert again.status_code == 304
    assert again.headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
async def test_etag_is_the_same_on_both_paths(client, thumbed, monkeypatch):
    fast = await client.get("/images/L1:dir%2Fa.png/thumb")
    monkeypatch.setattr(image_media, "read_thumb", lambda *a, **k: None)
    slow = await client.get("/images/L1:dir%2Fa.png/thumb")
    assert slow.status_code == 200
    assert fast.headers["etag"] == slow.headers["etag"]
    assert fast.headers["last-modified"] == slow.headers["last-modified"]


@pytest.mark.asyncio
async def test_backslash_spelling_falls_back_to_the_db(client, thumbed):
    r = await client.get("/images/L1:dir%5Ca.png/thumb")
    assert r.status_code == 200
    assert r.content == _webp()


@pytest.mark.asyncio
async def test_row_with_another_stored_key_still_serves(client, temp_db, seed):
    storage_fs.put_thumb("L1", "L1:old.png", _webp())
    seed("L1:new.png", thumb_key="L1/L1_old.png.webp")
    r = await client.get("/images/L1:new.png/thumb")
    assert r.status_code == 200
    assert r.content == _webp()


@pytest.mark.asyncio
async def test_missing_thumbnail_is_still_404(client, temp_db, seed):
    assert (await client.get("/images/L1:nope.png/thumb")).status_code == 404
    seed("L1:bare.png")
    assert (await client.get("/images/L1:bare.png/thumb")).status_code == 404


@pytest.mark.asyncio
async def test_large_thumbnail_takes_the_db_path(client, thumbed, monkeypatch):
    monkeypatch.setattr(image_media, "_INLINE_LIMIT", 10)
    r = await client.get("/images/L1:dir%2Fa.png/thumb")
    assert r.status_code == 200
    assert r.content == _webp()
    assert r.headers["etag"]


@pytest.mark.asyncio
async def test_range_request_is_honoured(client, thumbed):
    r = await client.get("/images/L1:dir%2Fa.png/thumb", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206
    assert r.content == _webp()[:10]


def test_read_thumb_reads_binary_mode(temp_db, monkeypatch):
    # Windows opens in text mode unless told otherwise, which mangles the bytes.
    # Linux has no such flag, so hand it one and check it reaches os.open.
    key = storage_fs.put_thumb("L1", "L1:a.png", _webp())
    monkeypatch.setattr(storage_fs.os, "O_BINARY", 0x8000, raising=False)
    flags = []
    real = storage_fs.os.open

    def spy(path, f, *a, **k):
        flags.append(f)
        return real(path, f & ~0x8000, *a, **k)

    monkeypatch.setattr(storage_fs.os, "open", spy)
    assert storage_fs.read_thumb(key, 1 << 20)[1] == _webp()
    assert flags[0] & 0x8000


@pytest.mark.asyncio
async def test_purged_row_with_no_stored_key_loses_its_file(client, temp_db, seed):
    from moire.database.db import sync_tx
    from moire.services.images import delete as image_delete

    storage_fs.put_thumb("L1", "L1:a.png", _webp())
    seed("L1:a.png")  # thumb_key NULL, as after a failed rethumb
    with sync_tx() as conn:
        keys = image_delete.delete_rows(conn, ["L1:a.png"])
    image_delete.drop_thumbs(keys)
    assert (await client.get("/images/L1:a.png/thumb")).status_code == 404


@pytest.mark.asyncio
async def test_failed_rethumb_removes_the_old_picture(
    client, temp_db, tmp_path, monkeypatch
):
    from moire.services.library import scanner, thumbnailer

    src = tmp_path / "a.png"
    src.write_bytes(b"not an image")
    image_id = scanner.image_id_for("L1", tmp_path, src)
    storage_fs.put_thumb("L1", image_id, _webp())
    monkeypatch.setattr(
        thumbnailer, "make_thumb_bytes", lambda p: (None, None, 0, 0, None)
    )
    result = scanner.process_image("L1", tmp_path, src)
    assert result.doc["thumb_key"] is None
    assert storage_fs.thumb_stamp(storage_fs.thumb_key(image_id)) is None


HOSTILE = [
    "..%2F..%2Fetc%2Fpasswd",
    "L1:..%2F..%2F..%2Fetc%2Fpasswd",
    "L1:dir%2F..%2F..%2FL2%2FL2_b.png",
    "L1:dir%2F..%2Fdir%2Fa.png",
    "%2Fetc%2Fpasswd",
    "L1:%00",
    "L1:..",
    ":",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("hostile", HOSTILE)
async def test_hostile_ids_never_reach_the_filesystem(client, thumbed, hostile):
    # A neighbour's thumbnail that a `..` would reach if the key went unchecked.
    storage_fs.put_thumb("L2", "L2:b.png", b"secret")
    r = await client.get(f"/images/{hostile}/thumb")
    assert r.status_code in (404, 405)
    assert b"secret" not in r.content


@pytest.mark.parametrize(
    "key",
    [
        "../x.webp",
        "a/../../x.webp",
        "a\\..\\..\\x.webp",
        "L1/L1_..\\..\\L2\\L2_b.png.webp",
        "/etc/passwd",
        "a\x00.webp",
        "",
    ],
)
def test_read_thumb_refuses_hostile_keys(temp_db, key):
    assert storage_fs.read_thumb(key, 1 << 20) is None


def test_read_thumb_bounds_and_skips(temp_db):
    key = storage_fs.put_thumb("L1", "L1:a.png", _webp())
    st, body = storage_fs.read_thumb(key, 1 << 20)
    assert body == _webp() and st.st_size == len(_webp())
    assert storage_fs.read_thumb(key, 10) is None
    assert storage_fs.read_thumb(key, 1 << 20, lambda st: False)[1] is None
    assert storage_fs.read_thumb("L1", 1 << 20) is None  # a directory
