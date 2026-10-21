"""SQLite engine lifecycle + connection helpers (async app + sync scanner).

Replaces the old Mongo ``motor.py`` / ``mongo.py`` wrappers. One SQLite file backs
both engines; WAL mode lets readers proceed during a write.

**Writer discipline (invariant).** SQLite is single-writer. The *actual* serializer
across the async app and the sync scanner threads is SQLite's own file lock +
``busy_timeout``, not the Python locks here. The :func:`write_lock` /
:func:`sync_write_lock` helpers only prevent self-contention *within* each side; the
real rule is **keep scanner write-transactions small and commit often** so no
transaction holds the file lock long enough to exhaust ``busy_timeout`` and surface
``database is locked`` to an app write.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager

import sqlalchemy as sa
from sqlalchemy.schema import CreateIndex
from sqlalchemy import Connection, create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    create_async_engine,
)

from ..core.config import settings
from .schema import RETIRED_INDEXES, metadata

_async_engine: AsyncEngine | None = None
_sync_engine: Engine | None = None

# Per-side locks: avoid one side racing itself. They do NOT serialize the async
# app against the scanner. SQLite's file lock + busy_timeout does that.
_async_write_lock = asyncio.Lock()
_sync_write_lock = threading.Lock()


def _apply_pragmas(dbapi_conn, _record) -> None:
    """Per-connection SQLite tuning. Runs on every new DBAPI connection."""
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute(f"PRAGMA busy_timeout={int(settings.sqlite_busy_timeout_ms)}")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


def _db_url(sync: bool) -> str:
    settings.sqlite_file.parent.mkdir(parents=True, exist_ok=True)
    driver = "sqlite" if sync else "sqlite+aiosqlite"
    return f"{driver}:///{settings.sqlite_file}"


def get_async_engine() -> AsyncEngine:
    global _async_engine
    if _async_engine is None:
        _async_engine = create_async_engine(_db_url(sync=False))
        event.listen(_async_engine.sync_engine, "connect", _apply_pragmas)
    return _async_engine


def get_sync_engine() -> Engine:
    global _sync_engine
    if _sync_engine is None:
        _sync_engine = create_engine(_db_url(sync=True))
        event.listen(_sync_engine, "connect", _apply_pragmas)
    return _sync_engine


@asynccontextmanager
async def async_conn() -> AsyncIterator[AsyncConnection]:
    """Read connection (autocommit semantics for SELECTs)."""
    async with get_async_engine().connect() as conn:
        yield conn


@asynccontextmanager
async def async_tx() -> AsyncIterator[AsyncConnection]:
    """Serialized write transaction (commits on exit, rolls back on error)."""
    async with _async_write_lock:
        async with get_async_engine().begin() as conn:
            yield conn


@contextmanager
def sync_conn() -> Iterator[Connection]:
    with get_sync_engine().connect() as conn:
        yield conn


@contextmanager
def sync_tx() -> Iterator[Connection]:
    """Serialized write transaction for the scanner/reproject threads."""
    with _sync_write_lock:
        with get_sync_engine().begin() as conn:
            yield conn


def write_lock() -> asyncio.Lock:
    return _async_write_lock


def sync_write_lock() -> threading.Lock:
    return _sync_write_lock


def _create_all(conn) -> None:
    metadata.create_all(conn)
    # create_all skips tables that already exist, and their indexes with them,
    # so an index added to an existing table would never reach an old DB.
    # Create each one on its own. IF NOT EXISTS, not checkfirst: reflection
    # can't see expression indexes, so checkfirst would re-create them.
    for table in metadata.sorted_tables:
        for index in table.indexes:
            conn.execute(CreateIndex(index, if_not_exists=True))
    for name in RETIRED_INDEXES:
        conn.execute(sa.text(f'DROP INDEX IF EXISTS "{name}"'))


async def ensure_schema() -> None:
    """Create tables + indexes if absent. Idempotent; safe on startup."""
    async with get_async_engine().begin() as conn:
        await conn.run_sync(_create_all)


def ensure_schema_sync() -> None:
    """Sync schema creation (tests / scripts without an event loop)."""
    with get_sync_engine().begin() as conn:
        _create_all(conn)


async def reset_engines() -> None:
    """Dispose + drop cached engines so the next access rebuilds them against the
    current ``settings.sqlite_path``. Used by tests to point at a temp DB."""
    global _async_engine, _sync_engine
    if _async_engine is not None:
        await _async_engine.dispose()
        _async_engine = None
    if _sync_engine is not None:
        _sync_engine.dispose()
        _sync_engine = None


# Re-export the table objects so call sites can `from ..database.db import t` and
# write `select(t.images)...` without importing schema separately.
from . import schema as t  # noqa: E402

__all__ = [
    "get_async_engine",
    "get_sync_engine",
    "async_conn",
    "async_tx",
    "sync_conn",
    "sync_tx",
    "write_lock",
    "sync_write_lock",
    "ensure_schema",
    "ensure_schema_sync",
    "reset_engines",
    "sa",
    "t",
]
