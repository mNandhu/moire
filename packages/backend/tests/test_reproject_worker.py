"""N5: reprojection decodes and derives in one worker process, so its pure
Python work doesn't hold the API process's GIL; if the worker can't start or
dies, the run derives in its own thread instead."""

import logging
import os
import signal
import subprocess
import sys
import time
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.metadata import derive_worker, reproject


@pytest.fixture
def worker(monkeypatch, stop_worker):
    """The worker on, for every page; stopped (and reset) after the test."""
    monkeypatch.setattr(derive_worker, "ENABLED", True)
    monkeypatch.setattr(derive_worker, "MIN_ROWS", 1)
    monkeypatch.setattr(derive_worker, "_warned", False)
    monkeypatch.setattr(derive_worker, "_failures", 0)
    monkeypatch.setattr(derive_worker, "_disabled", False)


def _raws(seed, raws: dict[str, str]):
    """Seed images with raw JSON text as stored (malformed text included)."""
    for image_id in raws:
        seed(image_id, tags=("manual:keep",))
    with db.sync_tx() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO image_gen_raw (_id, library_id, workflow_sig, raw) "
                "VALUES (:id, 'L1', NULL, :raw)"
            ),
            [{"id": i, "raw": raw} for i, raw in raws.items()],
        )


def _a1111(prompt):
    return '{"source": "a1111", "parameters": "%s\\nSteps: 20"}' % prompt


_MIXED = {
    "L1:good": _a1111("cat"),
    "L1:none": '{"source": "nope"}',  # nothing derivable: stamped
    "L1:badjson": '{"source": "a1111", ',  # raises: not stamped
    "L1:list": "[1, 2]",  # not a raw doc: raises, not stamped
}


def _tags(image_id):
    with db.sync_conn() as conn:
        return conn.execute(
            sa.select(t.images.c.tags).where(t.images.c._id == image_id)
        ).scalar()


def _stamped():
    with db.sync_conn() as conn:
        return set(
            conn.execute(
                sa.select(t.image_gen_derived.c._id).where(
                    t.image_gen_derived.c.derive_key.is_not(None)
                )
            ).scalars()
        )


def _check_mixed():
    assert "prompt:cat" in _tags("L1:good")
    assert _stamped() == {"L1:good", "L1:none"}


@pytest.fixture
def stop_worker():
    yield
    derive_worker.shutdown()
    derive_worker._closed = False
    derive_worker._failures = 0
    derive_worker._disabled = False


@pytest.mark.parametrize("in_worker", [True, False])
def test_rows_that_fail_are_skipped_not_stamped(
    temp_db, seed, monkeypatch, stop_worker, in_worker
):
    """Per row, in the worker and in-thread alike: a malformed raw skips its
    own row only (it used to fail the whole page read)."""
    if in_worker:
        monkeypatch.setattr(derive_worker, "MIN_ROWS", 1)
        monkeypatch.setattr(derive_worker, "ENABLED", True)
    _raws(seed, _MIXED)
    assert reproject.reproject_all() == 1
    assert (derive_worker._pool is not None) == in_worker
    _check_mixed()
    # The failed rows are read (and fail) again; the others are skipped.
    assert reproject.reproject_all() == 0
    assert _stamped() == {"L1:good", "L1:none"}


def test_the_worker_loads_only_what_derive_needs(worker):
    """Spawned, it imports gen_metadata's closure, not the app (no database
    engine, settings or server)."""
    future = derive_worker.submit(
        [("L1:a", "L1", None, _a1111("cat"))],
        {},
        _config(),
    )
    [(image_id, g, err)] = future.result(timeout=60)
    assert err is None and "cat" in g["prompt_terms"]
    loaded = (
        derive_worker._get_pool()
        .submit(eval, "sorted(__import__('sys').modules)")
        .result(timeout=60)
    )
    for mod in (
        "moire.main",
        "moire.database.db",
        "moire.core.config",
        "moire.services.metadata.extraction_settings",
        "moire.services.metadata.reproject",
        "uvicorn",
        "fastapi",
    ):
        assert mod not in loaded, mod
    assert "moire.services.metadata.gen_metadata" in loaded


def _config():
    from moire.services.metadata import extraction_settings

    return extraction_settings.load_sync()


def test_a_page_is_derived_while_the_one_before_is_written(
    temp_db, seed, worker, monkeypatch
):
    """Pipelined: page k+1 goes to the worker before page k is written."""
    monkeypatch.setattr(reproject, "_PAGE", 2)
    _raws(seed, {f"L1:{i}": _a1111(f"tag{i}") for i in range(5)})
    events = []
    submit, flush = derive_worker.submit, reproject._flush

    def submitting(rows, *a):
        events.append(("submit", [r[0] for r in rows]))
        return submit(rows, *a)

    def flushing(batch, **kw):
        events.append(("flush", [b[0] for b in batch]))
        return flush(batch, **kw)

    monkeypatch.setattr(derive_worker, "submit", submitting)
    monkeypatch.setattr(reproject, "_flush", flushing)
    monkeypatch.setattr(reproject, "_BATCH", 2)
    assert reproject.reproject_all() == 5
    assert events == [
        ("submit", ["L1:0", "L1:1"]),
        ("submit", ["L1:2", "L1:3"]),
        ("flush", ["L1:0", "L1:1"]),
        ("submit", ["L1:4"]),
        ("flush", ["L1:2", "L1:3"]),
        ("flush", ["L1:4"]),
    ]
    assert all(f"prompt:tag{i}" in _tags(f"L1:{i}") for i in range(5))


def test_a_worker_that_cannot_start_falls_back(
    temp_db, seed, worker, monkeypatch, caplog
):
    def no_pool():
        raise OSError("no processes here")

    monkeypatch.setattr(derive_worker, "_get_pool", no_pool)
    _raws(seed, _MIXED)
    with caplog.at_level(logging.WARNING, logger="moire.reproject"):
        assert reproject.reproject_all() == 1
    _check_mixed()
    assert [r for r in caplog.records if "worker process failed" in r.message]


def test_a_worker_that_dies_mid_run_falls_back_once(
    temp_db, seed, worker, monkeypatch, caplog
):
    """A broken pool: the page it lost and the rest of the run derive
    in-thread; the warning is logged once; the next run tries a new worker."""
    monkeypatch.setattr(reproject, "_PAGE", 2)
    _raws(seed, {f"L1:{i}": _a1111(f"tag{i}") for i in range(5)})
    calls = []
    real_submit = derive_worker.submit

    def dying(rows, *a):
        calls.append(len(rows))
        f = Future()
        f.set_exception(BrokenProcessPool("worker died"))
        return f

    monkeypatch.setattr(derive_worker, "submit", dying)
    with caplog.at_level(logging.WARNING, logger="moire.reproject"):
        assert reproject.reproject_all() == 5
        # The first page's failure turns the rest of the run in-thread (the
        # second page was already sent).
        assert calls == [2, 2]
        assert all(f"prompt:tag{i}" in _tags(f"L1:{i}") for i in range(5))
        monkeypatch.setattr(derive_worker, "submit", dying)
        reproject.reproject_all(force=True)
    warned = [r for r in caplog.records if "worker process failed" in r.message]
    assert len(warned) == 1
    assert calls == [2, 2, 2, 2]  # a new run tries the worker again

    # Its second failure gave it up for the process: in-thread from now on.
    monkeypatch.setattr(derive_worker, "submit", real_submit)
    assert reproject.reproject_all(force=True) == 5
    assert derive_worker._pool is None

    # And a real worker works after a broken one.
    monkeypatch.setattr(derive_worker, "_failures", 0)
    monkeypatch.setattr(derive_worker, "_disabled", False)
    assert reproject.reproject_all(force=True) == 5
    assert derive_worker._pool is not None


class _FakePool:
    stopped = False

    def shutdown(self, **kw):
        self.stopped = True


def test_a_stale_idle_timer_does_not_stop_the_pool(worker, monkeypatch):
    """A timer that fired while a newer run ended (and set a newer timer)
    must not stop the pool early or clear the newer timer."""
    monkeypatch.setattr(derive_worker, "IDLE_S", 3600)
    pool = _FakePool()
    monkeypatch.setattr(derive_worker, "_pool", pool)
    derive_worker.run_started()
    derive_worker.run_ended()
    first = derive_worker._idle
    derive_worker.run_started()
    derive_worker.run_ended()
    second = derive_worker._idle
    try:
        assert first is not second
        first.function(*first.args, **first.kwargs)  # fired late
        assert not pool.stopped
        assert derive_worker._idle is second
        assert derive_worker._pool is pool

        second.function(*second.args, **second.kwargs)
        assert pool.stopped and derive_worker._pool is None
    finally:
        second.cancel()


def test_an_idle_timer_after_shutdown_does_nothing(worker, monkeypatch):
    monkeypatch.setattr(derive_worker, "IDLE_S", 3600)
    pool = _FakePool()
    monkeypatch.setattr(derive_worker, "_pool", pool)
    derive_worker.run_started()
    derive_worker.run_ended()
    timer = derive_worker._idle
    timer.cancel()
    monkeypatch.setattr(derive_worker, "_closed", True)
    timer.function(*timer.args, **timer.kwargs)
    assert not pool.stopped


def test_a_worker_that_keeps_failing_is_given_up_on(
    temp_db, seed, worker, monkeypatch, caplog
):
    """Each id chunk is its own pass; a worker that fails every time is not
    respawned for each of them: after its second failure the process
    derives in-thread, said once."""
    monkeypatch.setattr(reproject, "_ID_CHUNK", 2)
    _raws(seed, {f"L1:{i}": _a1111(f"tag{i}") for i in range(8)})
    calls = []

    def dying(rows, *a):
        calls.append(len(rows))
        f = Future()
        f.set_exception(BrokenProcessPool("worker died"))
        return f

    monkeypatch.setattr(derive_worker, "submit", dying)
    with caplog.at_level(logging.WARNING, logger="moire.reproject"):
        assert reproject.reproject_ids([f"L1:{i}" for i in range(8)]) == 8
        reproject.reproject_all(force=True)
    assert calls == [2, 2]
    assert all(f"prompt:tag{i}" in _tags(f"L1:{i}") for i in range(8))
    assert len([r for r in caplog.records if "worker process failed" in r.message]) == 1
    assert len([r for r in caplog.records if "given up" in r.message]) == 1


def test_small_pages_stay_in_thread(temp_db, seed, worker, monkeypatch):
    monkeypatch.setattr(derive_worker, "MIN_ROWS", 50)
    _raws(seed, {"L1:a": _a1111("cat")})
    assert reproject.reproject_image("L1:a") == 1
    assert derive_worker._pool is None


def test_after_shutdown_runs_derive_in_thread(temp_db, seed, worker):
    derive_worker.shutdown()
    _raws(seed, {"L1:a": _a1111("cat")})
    assert reproject.reproject_all() == 1
    assert derive_worker._pool is None
    assert "prompt:cat" in _tags("L1:a")


_PARENT = """
import sys
from moire.services.metadata import derive_worker
pid = derive_worker._get_pool().submit(__import__("os").getpid).result(timeout=60)
print(pid, flush=True)
sys.stdin.read()
"""


@pytest.mark.skipif(sys.platform == "win32", reason="SIGKILL")
def test_the_worker_ends_with_a_killed_server():
    """A server killed outright never shuts the pool down: the worker sees
    its parent go and exits instead of waiting forever."""
    parent = subprocess.Popen(
        [sys.executable, "-c", _PARENT],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        pid = int(parent.stdout.readline())
        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(10)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        os.kill(pid, signal.SIGKILL)
        pytest.fail("the worker outlived its parent")
    finally:
        parent.kill()
