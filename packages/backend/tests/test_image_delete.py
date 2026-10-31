import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import image_delete, scan_reconcile, scan_writer, storage_fs


def _count(table) -> int:
    with db.sync_conn() as conn:
        return conn.execute(sa.select(sa.func.count()).select_from(table)).scalar()


def _add_raw(image_id: str) -> None:
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id, library_id="L1", workflow_sig=None, raw={}
            )
        )


def test_delete_rows_removes_every_table_and_returns_thumb_keys(temp_db, seed):
    seed("L1:a.png", tags=("cat",), thumb_key="L1/L1_a.png.webp")
    seed("L1:b.png", tags=("dog",))
    seed("L1:keep.png", tags=("cat",))
    _add_raw("L1:a.png")
    with db.sync_tx() as conn:
        keys = image_delete.delete_rows(conn, ["L1:a.png", "L1:b.png"])
    assert keys == ["L1/L1_a.png.webp"]
    assert _count(t.images) == 1
    assert _count(t.image_gen_raw) == 0
    assert _count(t.image_tags) == 1  # cascaded, keep.png's row survives


def _counting_selects() -> list[str]:
    """SELECTs run on any sync connection from now on."""
    selects: list[str] = []

    @sa.event.listens_for(db.get_sync_engine(), "before_cursor_execute")
    def _seen(conn, cursor, statement, *a):
        if statement.lstrip().upper().startswith("SELECT"):
            selects.append(statement)

    return selects


def test_delete_rows_takes_thumb_keys_the_caller_holds(temp_db, seed, monkeypatch):
    """Keys passed in are returned as given (``None`` dropped) and the rows
    are not read again for them."""
    seed("L1:a.png", thumb_key="L1/L1_a.png.webp")
    seed("L1:b.png")
    selects = _counting_selects()
    with db.sync_tx() as conn:
        keys = image_delete.delete_rows(
            conn, ["L1:a.png", "L1:b.png"], thumb_keys=["L1/L1_a.png.webp", None]
        )
    assert keys == ["L1/L1_a.png.webp"]
    assert not [s for s in selects if "thumb_key" in s]
    assert _count(t.images) == 0


def test_delete_stale_passes_the_keys_reconcile_read(temp_db, seed, monkeypatch):
    dropped: list[str] = []
    monkeypatch.setattr(storage_fs, "delete_thumb", dropped.append)
    seed("L1:a.png", thumb_key="k0")
    selects = _counting_selects()
    scan_reconcile._delete_stale(["L1:a.png"], {"L1:a.png": "k0"})
    assert not [s for s in selects if "thumb_key" in s]
    assert dropped == ["k0"]


def test_delete_rows_handles_more_ids_than_one_statement_chunk(temp_db, seed):
    ids = [f"L1:{i}.png" for i in range(image_delete._STMT_CHUNK + 5)]
    for i in ids:
        seed(i)
    with db.sync_tx() as conn:
        image_delete.delete_rows(conn, ids)
    assert _count(t.images) == 0


def test_delete_stale_commits_in_chunks_and_drops_thumbs(temp_db, seed, monkeypatch):
    monkeypatch.setattr(scan_reconcile, "_STALE_CHUNK", 2)
    dropped: list[str] = []
    monkeypatch.setattr(storage_fs, "delete_thumb", dropped.append)
    ids = [f"L1:{i}.png" for i in range(5)]
    for n, i in enumerate(ids):
        seed(i, thumb_key=f"k{n}")
    commits = []
    real_tx = scan_reconcile.sync_tx

    def counting_tx():
        commits.append(1)
        return real_tx()

    monkeypatch.setattr(scan_reconcile, "sync_tx", counting_tx)
    scan_reconcile._delete_stale(ids)
    assert len(commits) == 3
    assert _count(t.images) == 0
    assert sorted(dropped) == [f"k{n}" for n in range(5)]


def test_delete_stale_failure_keeps_earlier_chunks_consistent(
    temp_db, seed, monkeypatch
):
    monkeypatch.setattr(scan_reconcile, "_STALE_CHUNK", 2)
    dropped: list[str] = []
    monkeypatch.setattr(storage_fs, "delete_thumb", dropped.append)
    monkeypatch.setattr(scan_writer.time, "sleep", lambda s: None)
    ids = [f"L1:{i}.png" for i in range(4)]
    for n, i in enumerate(ids):
        seed(i, thumb_key=f"k{n}")
    real = image_delete.delete_rows
    calls = []

    def flaky(conn, chunk, **kw):
        calls.append(1)
        if len(calls) >= 2:  # every retry of chunk 2 fails too
            raise RuntimeError("boom")
        return real(conn, chunk, **kw)

    monkeypatch.setattr(image_delete, "delete_rows", flaky)
    try:
        scan_reconcile._delete_stale(ids)
    except RuntimeError:
        pass
    assert _count(t.images) == 2  # first chunk gone, second rolled back
    assert sorted(dropped) == ["k0", "k1"]  # only committed rows lose thumbs


def test_delete_stale_retries_a_locked_chunk(temp_db, seed, monkeypatch):
    monkeypatch.setattr(scan_reconcile, "_STALE_CHUNK", 2)
    monkeypatch.setattr(scan_writer.time, "sleep", lambda s: None)
    monkeypatch.setattr(storage_fs, "delete_thumb", lambda k: None)
    ids = [f"L1:{i}.png" for i in range(4)]
    for i in ids:
        seed(i)
    real = image_delete.delete_rows
    calls = []

    def locked_once(conn, chunk, **kw):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("database is locked")
        return real(conn, chunk, **kw)

    monkeypatch.setattr(image_delete, "delete_rows", locked_once)
    scan_reconcile._delete_stale(ids)
    assert _count(t.images) == 0
