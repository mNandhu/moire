"""Deleting image rows: the one list of tables that go with an image.

An image's row, its cold raw-gen row and (by foreign-key cascade) its
``image_tags`` / ``image_gen_terms`` rows are removed together, and its
thumbnail files after. The caller owns the transaction. After it commits the
caller calls ``tag_index.invalidate()`` (the cascade moved tag counts) and
then :func:`drop_thumbs` with the keys these helpers return.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

import sqlalchemy as sa

from ...database import schema as t
from ..library import storage_fs

logger = logging.getLogger("moire.image_delete")

# Keeps one IN list far below SQLite's bound-variable limit.
_STMT_CHUNK = 500


def _plan(ids: Iterable[str], *, read_keys: bool):
    """Per chunk of ids: the thumb-key select (``None`` unless ``read_keys``),
    then the delete statements. The sync and async helpers below only differ
    in how they execute these."""
    ids = list(ids)
    for i in range(0, len(ids), _STMT_CHUNK):
        chunk = ids[i : i + _STMT_CHUNK]
        keys_stmt = None
        if read_keys:
            keys_stmt = sa.select(t.images.c.thumb_key).where(t.images.c._id.in_(chunk))
        yield (
            keys_stmt,
            _stmts(t.images.c._id.in_(chunk), t.image_gen_raw.c._id.in_(chunk)),
        )


def _stmts(where_images, where_raw):
    # Order matters little (the cascade is by FK) but the images row goes first.
    return sa.delete(t.images).where(where_images), sa.delete(t.image_gen_raw).where(
        where_raw
    )


def _keys_to_drop(ids: list[str], stored: Iterable[str | None]) -> list[str]:
    """The stored keys plus each id's derived one. The thumbnail route serves
    whatever is at the derived key without asking the DB, so a file there has
    to go even when the row's own key is NULL or says otherwise."""
    return list(
        dict.fromkeys([k for k in stored if k] + [storage_fs.thumb_key(i) for i in ids])
    )


def delete_rows(
    conn, ids: Iterable[str], *, thumb_keys: Iterable[str | None] | None = None
) -> list[str]:
    """Delete these images' rows inside the caller's sync transaction.
    Returns the thumbnail keys to pass to :func:`drop_thumbs` after commit:
    ``thumb_keys`` when the caller already read them with the rows (they are
    not read again), else read here, plus each id's derived key."""
    ids = list(ids)
    keys: list[str] = []
    for keys_stmt, deletes in _plan(ids, read_keys=thumb_keys is None):
        if keys_stmt is not None:
            keys += [k for k in conn.execute(keys_stmt).scalars() if k]
        for stmt in deletes:
            conn.execute(stmt)
    return _keys_to_drop(ids, keys if thumb_keys is None else thumb_keys)


async def delete_rows_async(
    conn, ids: Iterable[str], *, thumb_keys: Iterable[str | None] | None = None
) -> list[str]:
    """`delete_rows` on an async connection."""
    ids = list(ids)
    keys: list[str] = []
    for keys_stmt, deletes in _plan(ids, read_keys=thumb_keys is None):
        if keys_stmt is not None:
            keys += [k for k in (await conn.execute(keys_stmt)).scalars() if k]
        for stmt in deletes:
            await conn.execute(stmt)
    return _keys_to_drop(ids, keys if thumb_keys is None else thumb_keys)


async def delete_library_rows_async(conn, library_id: str) -> None:
    """Delete every image row of a library (its thumbnails go by folder:
    `storage_fs.delete_by_prefix`)."""
    for stmt in _stmts(
        t.images.c.library_id == library_id, t.image_gen_raw.c.library_id == library_id
    ):
        await conn.execute(stmt)


def drop_thumbs(keys: Iterable[str]) -> None:
    """Remove thumbnail files, best effort. A leftover wastes space and stays
    reachable by its image's exact id: the thumbnail route doesn't ask the DB."""
    for key in keys:
        try:
            storage_fs.delete_thumb(key)
        except Exception:
            logger.debug("Could not delete thumbnail %s", key, exc_info=True)
