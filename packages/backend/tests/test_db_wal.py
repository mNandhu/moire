"""The WAL stays bounded: a size limit on every connection, and a TRUNCATE
checkpoint after big writes that gives up quickly when the database is busy."""

import logging
import os
import sqlite3
import time

import pytest
import sqlalchemy as sa

from moire.core.config import settings
from moire.database import db
from moire.database import schema as t


def _wal_size() -> int:
    path = f"{settings.sqlite_path}-wal"
    return os.path.getsize(path) if os.path.exists(path) else 0


def _write_some():
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw),
            [
                {"_id": f"L1:{i}", "library_id": "L1", "raw": {"n": "x" * 500}}
                for i in range(200)
            ],
        )


def _write_some_more():
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw),
            [{"_id": f"L2:{i}", "library_id": "L2", "raw": {}} for i in range(50)],
        )


async def test_both_engines_limit_the_wal(temp_db):
    with db.sync_conn() as conn:
        assert conn.exec_driver_sql("PRAGMA journal_size_limit").scalar() == (
            64 * 1024 * 1024
        )
    async with db.async_conn() as conn:
        result = await conn.exec_driver_sql("PRAGMA journal_size_limit")
        assert result.scalar() == 64 * 1024 * 1024


def test_a_checkpoint_truncates_the_wal(temp_db):
    _write_some()
    assert _wal_size() > 0

    db.checkpoint_wal(min_bytes=0)

    assert _wal_size() == 0


def test_a_small_wal_is_left_alone(temp_db):
    _write_some()
    size = _wal_size()
    assert 0 < size < 64 * 1024 * 1024

    db.checkpoint_wal()  # under the default threshold: a stat, nothing else

    assert _wal_size() == size


def test_a_busy_checkpoint_gives_up_quickly(temp_db, caplog):
    _write_some()
    # Another connection holds a read snapshot the checkpoint must wait for.
    reader = sqlite3.connect(settings.sqlite_path, isolation_level=None)
    reader.execute("BEGIN")
    reader.execute("SELECT count(*) FROM image_gen_raw").fetchone()
    _write_some_more()
    caplog.set_level(logging.DEBUG, logger="moire.db")
    try:
        started = time.monotonic()
        db.checkpoint_wal(min_bytes=0)  # never raises
        assert time.monotonic() - started < settings.sqlite_busy_timeout_ms / 2000
    finally:
        reader.close()

    assert "busy=1" in caplog.text
    # The pooled connection got its configured wait back.
    with db.sync_conn() as conn:
        assert conn.exec_driver_sql("PRAGMA busy_timeout").scalar() == (
            settings.sqlite_busy_timeout_ms
        )


def test_a_failing_checkpoint_does_not_raise(temp_db, monkeypatch):
    def broken():
        raise RuntimeError("no engine")

    monkeypatch.setattr(db, "get_sync_engine", broken)
    db.checkpoint_wal(min_bytes=0)


# --- reprojection runs checkpoint once at the end ----------------------------------


@pytest.fixture
def checkpoints(monkeypatch):
    from moire.services.metadata import reproject

    seen: list[int] = []
    monkeypatch.setattr(reproject, "checkpoint_wal", lambda: seen.append(1))
    return seen


def _raw(seed, image_id):
    seed(image_id, tags=())
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                raw={"source": "a1111", "parameters": "smile\nSteps: 20"},
            )
        )


def test_a_reprojection_run_checkpoints_once(temp_db, seed, monkeypatch, checkpoints):
    from moire.services.metadata import reproject

    for name in ("a", "b", "c"):
        _raw(seed, f"L1:{name}")
    monkeypatch.setattr(reproject, "_BATCH", 1)

    assert reproject.reproject_all() == 3
    assert checkpoints == [1]

    # Nothing stale, nothing written: nothing to checkpoint.
    assert reproject.reproject_all() == 0
    assert checkpoints == [1]


def test_a_single_image_reprojection_does_not_checkpoint(temp_db, seed, checkpoints):
    from moire.services.metadata import reproject

    _raw(seed, "L1:a")

    assert reproject.reproject_image("L1:a") == 1
    assert checkpoints == []


def test_an_inline_reprojection_does_not_checkpoint(temp_db, seed, checkpoints):
    """The rename path runs it inside the request: no checkpoint there."""
    from moire.services.metadata import reproject

    _raw(seed, "L1:a")
    _raw(seed, "L1:b")

    assert reproject.try_reproject_ids_tracked(["L1:a", "L1:b"]) == 2
    assert checkpoints == []
