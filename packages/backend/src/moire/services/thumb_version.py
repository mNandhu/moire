"""Versioned thumbnail URLs. A thumbnail is served ``immutable`` for a year, so
its URL carries ``v``: a hash of the thumbnail file's own mtime and size.
Whatever rebuilds a thumbnail (a file edited in place, new thumbnail
settings, a scan retrying a failed file) writes a new file and so gives a new
URL; a rescan that writes the same bytes leaves the file, and the URL, alone
(`storage_fs.put_thumb`). The URL only changes once the new file is on disk."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from urllib.parse import quote

import anyio

from ..core.config import API_PREFIX
from . import storage_fs


def thumb_url(image_id: str, v: str) -> str:
    """The streaming ``/thumb`` route for an image at version ``v``. Lets the
    grid render an ``<img src>`` with no extra resolve hop."""
    return f"{API_PREFIX}/images/{quote(image_id, safe='')}/thumb?v={v}"


def version(key: str | None) -> str:
    """The thumbnail file's version: "0" while there is none."""
    try:
        st = storage_fs.thumb_stat(key) if key else None
    except (OSError, ValueError):
        st = None
    if st is None:
        return "0"
    raw = f"{st.st_mtime_ns}|{st.st_size}"
    return hashlib.blake2s(raw.encode(), digest_size=6).hexdigest()


def _url(image_id: str, key: str | None) -> str:
    return thumb_url(image_id, version(key))


async def urls_for_rows(rows: list[dict], id_key: str = "_id") -> None:
    """Set ``thumb_url`` on rows, from their ``thumb_key`` when they carry it."""

    def build() -> None:
        for r in rows:
            image_id = r[id_key]
            key = r.get("thumb_key") or storage_fs.thumb_key(image_id)
            r["thumb_url"] = _url(image_id, key)

    await anyio.to_thread.run_sync(build)


async def urls(ids: Iterable[str | None]) -> dict[str, str]:
    """Each image id's thumbnail URL, by id (a stat per thumbnail, no query:
    the key follows from the id)."""
    want = list(dict.fromkeys(i for i in ids if i))
    if not want:
        return {}
    return await anyio.to_thread.run_sync(
        lambda: {i: _url(i, storage_fs.thumb_key(i)) for i in want}
    )


async def attach(items: dict | list | None, id_key: str = "image_id") -> None:
    """Set ``thumb_url`` beside ``id_key`` on a dict or a list of dicts (None
    where there is no image)."""
    if items is None:
        return
    rows = [items] if isinstance(items, dict) else items
    got = await urls(r.get(id_key) for r in rows)
    for r in rows:
        r["thumb_url"] = got.get(r.get(id_key) or "")
