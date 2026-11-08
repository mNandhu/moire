"""Find images by file name, for the Ctrl/Cmd+K search.

Matches the image's path inside its library (the part of ``_id`` after
``{library_id}:``), so a folder name finds its images too but the library's
own root on disk doesn't match everything. ``_`` and space are one, like tag
names: ``comfyui 0012`` finds ``ComfyUI_00123_.png``. Hidden images (the
sensitivity filter, quarantine) never come back.
"""

from __future__ import annotations

import posixpath

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn
from . import image_visibility

# Matches read before ranking: newest first, so a common word still answers
# from the latest images without walking the whole library.
SCAN = 200


def normalize(text: str) -> str:
    """The form both sides are compared in: lower case, ``_`` as space,
    runs of space as one, ``\\`` as ``/``."""
    return " ".join(text.replace("_", " ").replace("\\", "/").lower().split())


def _relative_path():
    return sa.func.substr(t.images.c._id, sa.func.length(t.images.c.library_id) + 2)


def _rank(needle: str, name: str) -> int:
    """File names that start with the query, then ones holding it, then
    images found by a folder name only."""
    n = normalize(name)
    if n.startswith(needle):
        return 0
    return 1 if needle in n else 2


async def search(query: str, limit: int) -> list[dict]:
    needle = normalize(query)
    if not needle:
        return []
    rel = _relative_path()
    # SQLite has no regex replace; collapsing repeated spaces on the stored
    # side would need one, so a doubled `__` only matches a doubled space.
    spelled = sa.func.lower(sa.func.replace(sa.func.replace(rel, "_", " "), "\\", "/"))
    stmt = (
        sa.select(t.images.c._id, rel.label("rel"), t.images.c.thumb_key)
        .where(spelled.contains(needle, autoescape=True), image_visibility.visible())
        .order_by(t.SORT_RECENT.desc(), t.images.c._id.desc())
        .limit(SCAN)
    )
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).mappings().all()
    out = []
    for r in rows:
        rel_path = r["rel"].replace("\\", "/")
        folder, name = posixpath.split(rel_path)
        out.append(
            {
                "_id": r["_id"],
                "name": name,
                "folder": folder,
                "thumb_key": r["thumb_key"],
            }
        )
    # Stable: newest first within each rank.
    out.sort(key=lambda row: _rank(needle, row["name"]))
    return out[:limit]
