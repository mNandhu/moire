"""The watcher's child process wiring: events from `watch_proc` reach the
library's thread, a dead child is restarted with every watch, and
`stop_all` ends it."""

import threading
import time

import pytest

from moire.core.config import settings
from moire.services import library_watch, scan_incremental, scanner


def _wait(pred, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def ingested(monkeypatch):
    """Records (library_id, file name) for every ingest the watcher makes."""
    library_watch.stop_all()  # a child left by an earlier test's library add
    monkeypatch.setattr(settings, "watch_debounce_ms", 50)
    monkeypatch.setattr(settings, "watch_stability_window_ms", 50)
    monkeypatch.setattr(library_watch._child, "restart_delay_s", 0.0)
    seen: list[tuple[str, str]] = []
    got = threading.Event()

    def fake_ingest(library_id, _root, path):
        seen.append((library_id, path.name))
        got.set()
        return True

    monkeypatch.setattr(scan_incremental, "ingest_single_file", fake_ingest)
    monkeypatch.setattr(scanner, "is_scanning", lambda _id: False)
    yield seen, got
    library_watch.stop_all()


@pytest.fixture
def spawned(monkeypatch):
    """Every child process the watcher starts."""
    procs = []
    real = library_watch._child.spawn

    def spy(closing):
        proc = real(closing)
        procs.append(proc)
        return proc

    monkeypatch.setattr(library_watch._child, "spawn", spy)
    return procs


def _saw(lib, name, got):
    # The child may still be walking the root; keep touching until seen.
    def touched():
        (lib / name).write_bytes(b"x" * 16)
        return got.wait(0.5)

    return _wait(touched)


def test_child_events_reach_the_library(tmp_path, ingested, spawned):
    seen, got = ingested
    lib = tmp_path / "lib"
    lib.mkdir()
    library_watch.start_watch("W1", str(lib))
    assert library_watch.is_watching("W1")

    assert _saw(lib, "a.png", got)
    assert ("W1", "a.png") in seen

    library_watch.stop_all()
    assert not library_watch.is_watching("W1")
    assert len(spawned) == 1
    assert spawned[0].wait(timeout=5) is not None


def test_dead_child_is_restarted_with_its_watches(tmp_path, ingested, spawned):
    seen, got = ingested
    lib = tmp_path / "lib"
    lib.mkdir()
    library_watch.start_watch("W1", str(lib))
    assert _saw(lib, "a.png", got)

    spawned[0].kill()
    assert _wait(lambda: len(spawned) == 2)
    got.clear()
    assert _saw(lib, "b.png", got)
    assert ("W1", "b.png") in seen


def test_restarted_watch_drops_the_old_roots_batches(tmp_path, ingested):
    seen, got = ingested
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir()
    new.mkdir()
    library_watch.start_watch("W1", str(old))
    gen = library_watch._watches["W1"].gen
    library_watch.start_watch("W1", str(new))

    # A batch the child sent for the replaced watch, still in flight.
    library_watch._route(
        {"key": "W1", "gen": gen, "changes": [[1, str(old / "late.png")]]}
    )
    assert _saw(new, "c.png", got)
    assert ("W1", "c.png") in seen
    assert ("W1", "late.png") not in seen


def test_backoff_does_not_hold_up_stop_all(tmp_path, ingested, spawned, monkeypatch):
    lib = tmp_path / "lib"
    lib.mkdir()
    library_watch.start_watch("W1", str(lib))
    assert _wait(lambda: len(spawned) == 1)
    monkeypatch.setattr(library_watch._child, "restart_delay_s", 60.0)
    spawned[0].kill()
    assert _wait(lambda: library_watch._child.respawn_at > time.monotonic() + 30)

    t = time.monotonic()
    library_watch.stop_all()
    assert time.monotonic() - t < 3
    assert len(spawned) == 1


def test_batches_queued_during_an_ingest_are_merged(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "watch_stability_window_ms", 50)
    monkeypatch.setattr(scanner, "is_scanning", lambda _id: False)
    calls = []
    monkeypatch.setattr(
        scan_incremental,
        "ingest_single_file",
        lambda _lib, _root, p: calls.append(p.name),
    )
    (tmp_path / "a.png").write_bytes(b"x")
    w = library_watch._Watch("W1", tmp_path)
    batch = {(library_watch.Change.modified, str(tmp_path / "a.png"))}
    for _ in range(3):
        w.queue.put(set(batch))
    th = threading.Thread(target=library_watch._run_watch, args=(w,))
    th.start()
    assert _wait(lambda: w.queue.empty() and calls)
    w.queue.put(None)
    th.join(timeout=5)
    assert calls == ["a.png"]
