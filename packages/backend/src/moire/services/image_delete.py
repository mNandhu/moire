"""Deleting image rows: the one list of tables that go with an image.

An image's row, its cold raw-gen row and (by foreign-key cascade) its
``image_tags`` / ``image_gen_terms`` rows are removed together, and its
thumbnail files after. The caller owns the transaction. After it commits the
caller calls ``tag_index.invalidate()`` (the cascade moved tag counts) and
then :func:`drop_thumbs` with the keys these helpers return.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence

import sqlalchemy as sa

from ..database import schema as t
from . import storage_fs

logger = logging.getLogger("moire.image_delete")

# Keeps one IN list far below SQLite's bound-variable limit.
_STMT_CHUNK = 500


def _slices(ids: Sequence[str]):
    for i in range(0, len(ids), _STMT_CHUNK):
        yield ids[i : i + _STMT_CHUNK]


def _stmts(where_images, where_raw):
    # Order matters little (the cascade is by FK) but the images row goes first.
    return sa.delete(t.images).where(where_images), sa.delete(t.image_gen_raw).where(
        where_raw
    )


def delete_rows(conn, ids: Iterable[str]) -> list[str]:
    """Delete these images' rows inside the caller's sync transaction.
    Returns the thumbnail keys to pass to :func:`drop_thumbs` after commit."""
    keys: list[str] = []
    for chunk in _slices(list(ids)):
        keys += [
            k
            for k in conn.execute(
                sa.select(t.images.c.thumb_key).where(t.images.c._id.in_(chunk))
            ).scalars()
            if k
        ]
        for stmt in _stmts(t.images.c._id.in_(chunk), t.image_gen_raw.c._id.in_(chunk)):
            conn.execute(stmt)
    return keys


async def delete_rows_async(conn, ids: Iterable[str]) -> list[str]:
    """`delete_rows` on an async connection."""
    keys: list[str] = []
    for chunk in _slices(list(ids)):
        keys += [
            k
            for k in (
                await conn.execute(
                    sa.select(t.images.c.thumb_key).where(t.images.c._id.in_(chunk))
                )
            ).scalars()
            if k
        ]
        for stmt in _stmts(t.images.c._id.in_(chunk), t.image_gen_raw.c._id.in_(chunk)):
            await conn.execute(stmt)
    return keys


async def delete_library_rows_async(conn, library_id: str) -> None:
    """Delete every image row of a library (its thumbnails go by folder:
    `storage_fs.delete_by_prefix`)."""
    for stmt in _stmts(
        t.images.c.library_id == library_id, t.image_gen_raw.c.library_id == library_id
    ):
        await conn.execute(stmt)


def drop_thumbs(keys: Iterable[str]) -> None:
    """Remove thumbnail files, best effort: a leftover only wastes space."""
    for key in keys:
        try:
            storage_fs.delete_thumb(key)
        except Exception:
            logger.debug("Could not delete thumbnail %s", key, exc_info=True)
