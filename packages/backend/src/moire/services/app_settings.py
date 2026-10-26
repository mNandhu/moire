"""The ``app_settings`` table is a bag of JSON documents keyed by row id. This
is the one place that reads and upserts them; each settings module keeps its
own row id, defaults and validation.

``doc_stmt`` lets a caller read several rows on one connection. Writes replace
the whole document (merge in the caller if it wants a patch). A writer that
owns the transaction and affects tags still calls ``tag_index.invalidate()``
after it commits.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database import schema as t
from ..database.db import async_conn, async_tx, sync_conn, sync_tx


def doc_stmt(row: str):
    """SELECT of the document stored under ``row``."""
    return sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == row)


def upsert_stmt(row: str, doc: dict[str, Any]):
    """INSERT the document, replacing any existing one."""
    stmt = sqlite_insert(t.app_settings).values(_id=row, doc=doc)
    return stmt.on_conflict_do_update(
        index_elements=[t.app_settings.c._id], set_={"doc": stmt.excluded.doc}
    )


async def read(row: str) -> dict[str, Any] | None:
    """The stored document, or None if the row was never written."""
    async with async_conn() as conn:
        return (await conn.execute(doc_stmt(row))).scalar()


def read_sync(row: str) -> dict[str, Any] | None:
    with sync_conn() as conn:
        return conn.execute(doc_stmt(row)).scalar()


async def write(row: str, doc: dict[str, Any]) -> None:
    async with async_tx() as conn:
        await conn.execute(upsert_stmt(row, doc))


def write_sync(row: str, doc: dict[str, Any]) -> None:
    with sync_tx() as conn:
        conn.execute(upsert_stmt(row, doc))
