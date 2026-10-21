"""Versioned thumbnail URLs. A thumbnail is served ``immutable`` for a year, so
its URL carries ``v``: a hash of the image file's mtime and its library's last
full-scan stamp (the thumbnail recipe it was built with). Editing a file or
rebuilding a library's thumbnails gives new URLs; nothing else does.

The stamp is the one the scan recorded when it finished, not the current
settings: a URL changes only once the new thumbnails are on disk."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from urllib.parse import quote

import sqlalchemy as sa

from ..core.config import API_PREFIX
from ..database.db import async_conn
from ..database import schema as t

# library id -> its last full-scan stamp. Loaded once; the scanner sets it.
_stamps: dict[str, str | None] | None = None

# Ids per `IN (...)` lookup, under SQLite's bound-parameter limit.
_CHUNK = 500

_PREFIX = "thumbs:"


async def stamps() -> dict[str, str | None]:
    """Each library's last full-scan stamp, for `url`."""
    global _stamps
    if _stamps is None:
        async with async_conn() as conn:
            rows = await conn.execute(
                sa.select(t.app_settings.c._id, t.app_settings.c.doc).where(
                    t.app_settings.c._id.startswith(_PREFIX)
                )
            )
            _stamps = {
                r._id.removeprefix(_PREFIX): (r.doc or {}).get("stamp") for r in rows
            }
    return _stamps


def set_stamp(library_id: str, stamp: str | None) -> None:
    """A library's scan finished with ``stamp`` (after its commit)."""
    if _stamps is not None:
        _stamps[library_id] = stamp


def thumb_url(image_id: str, v: str) -> str:
    """The streaming ``/thumb`` route for an image at version ``v``. Lets the
    grid render an ``<img src>`` with no extra resolve hop."""
    return f"{API_PREFIX}/images/{quote(image_id, safe='')}/thumb?v={v}"


def version(stamps: dict[str, str | None], image_id: str, mtime: float | None) -> str:
    library_id = image_id.split(":", 1)[0]
    raw = f"{mtime!r}|{stamps.get(library_id)}"
    return hashlib.blake2s(raw.encode(), digest_size=6).hexdigest()


def url(stamps: dict[str, str | None], image_id: str, mtime: float | None) -> str:
    """An image's thumbnail URL from its row's ``mtime`` (`stamps()`)."""
    return thumb_url(image_id, version(stamps, image_id, mtime))


async def urls_for_rows(rows: Iterable[dict], id_key: str = "_id") -> None:
    """Set ``thumb_url`` on rows that carry their image's ``mtime``."""
    got = await stamps()
    for r in rows:
        image_id = r[id_key]
        r["thumb_url"] = url(got, image_id, r.get("mtime"))


async def urls(ids: Iterable[str | None]) -> dict[str, str]:
    """Each image id's thumbnail URL, by id: one lookup of their mtimes."""
    want = list(dict.fromkeys(i for i in ids if i))
    if not want:
        return {}
    got = await stamps()
    mtimes: dict[str, float | None] = {}
    async with async_conn() as conn:
        for at in range(0, len(want), _CHUNK):
            part = want[at : at + _CHUNK]
            rows = await conn.execute(
                sa.select(t.images.c._id, t.images.c.mtime).where(
                    t.images.c._id.in_(part)
                )
            )
            mtimes.update({r._id: r.mtime for r in rows})
    return {i: url(got, i, mtimes.get(i)) for i in want}


async def attach(items: dict | list | None, id_key: str = "image_id") -> None:
    """Set ``thumb_url`` beside ``id_key`` on a dict or a list of dicts (None
    where there is no image)."""
    if items is None:
        return
    rows = [items] if isinstance(items, dict) else items
    got = await urls(r.get(id_key) for r in rows)
    for r in rows:
        r["thumb_url"] = got.get(r.get(id_key) or "")


def reset_for_tests() -> None:
    global _stamps
    _stamps = None
