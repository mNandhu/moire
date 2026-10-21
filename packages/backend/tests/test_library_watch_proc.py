"""The watcher's child process wiring: events from `watch_proc` reach the
library's thread, and `stop_all` ends the child."""

import threading
import time

from moire.core.config import settings
from moire.services import library_watch, scanner


def _wait(pred, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def test_child_events_reach_the_library(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "watch_debounce_ms", 50)
    monkeypatch.setattr(settings, "watch_stability_window_ms", 50)
    seen: list[tuple[str, str]] = []
    got = threading.Event()

    def fake_ingest(library_id, root, path):
        seen.append((library_id, path.name))
        got.set()
        return True

    monkeypatch.setattr(scanner, "ingest_single_file", fake_ingest)
    monkeypatch.setattr(scanner, "is_scanning", lambda _id: False)

    lib = tmp_path / "lib"
    lib.mkdir()
    try:
        library_watch.start_watch("W1", str(lib))
        assert library_watch.is_watching("W1")
        child = library_watch._child
        assert child is not None and child.poll() is None

        # The child may still be walking the root; keep touching until seen.
        def touched():
            (lib / "a.png").write_bytes(b"x" * 16)
            return got.wait(0.5)

        assert _wait(touched)
        assert ("W1", "a.png") in seen
    finally:
        library_watch.stop_all()

    assert not library_watch.is_watching("W1")
    assert library_watch._child is None
    assert child.wait(timeout=5) is not None
