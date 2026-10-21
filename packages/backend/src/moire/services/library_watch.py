"""Per-library filesystem watcher: near-real-time incremental indexing.

Hybrid model (see docs/phase-functional-features.md #4): this module gives the
"near real-time" half: a `watchfiles` thread per watched library that feeds
single-file adds/modifies/deletes to `scanner.ingest_single_file` /
`scanner.remove_single_image`. The "periodic reconciliation" half is just the
existing full `scan_library_async`, re-run on a timer here as a backstop for
events a watcher misses (network shares, drives that don't deliver
inotify/ReadDirectoryChanges reliably, the process being down when a change
happened).

The watching itself (`watchfiles`, which debounces bursts into batches) runs
in one child process, `watch_proc`: watchfiles holds the GIL while it walks a
new root, which froze the server for the whole walk (10 to 30 s at boot with
dozens of libraries on a slow mount). One thread per library here takes that
library's batches off a queue. Debounced batches still name files that may be
mid-write (a generator tool still streaming bytes to disk); `_wait_stable`
re-reads size across a short quiet window before ingesting, and gives up
(leaving the row for the next reconciliation pass) after a bounded number of
attempts rather than blocking the watcher thread indefinitely.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

from watchfiles import Change

from ..core.config import settings
from . import library_nesting, scanner

logger = logging.getLogger("moire.watch")

# Editors/downloaders/generators commonly stage output under these suffixes
# before the final rename; never ingest them directly.
_IGNORED_SUFFIXES = (".tmp", ".part", ".partial", ".crdownload", ".download")


class _Watch:
    __slots__ = (
        "library_id",
        "root",
        "key",
        "queue",
        "stop_event",
        "thread",
        "reconcile_timer",
    )

    def __init__(self, library_id: str, root: Path) -> None:
        self.library_id = library_id
        self.root = root
        # Names this watch in the child, so a restarted watch never gets
        # batches still in flight for the root it replaced.
        self.key = str(next(_keys))
        # Batches of (Change, path) from the child; None ends the thread.
        self.queue: queue.Queue[set[tuple[Change, str]] | None] = queue.Queue()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.reconcile_timer: threading.Timer | None = None


_keys = itertools.count(1)
_lock = threading.Lock()
_watches: dict[str, _Watch] = {}
_by_key: dict[str, _Watch] = {}

# The child process; `_child_lock` also serializes writes to its stdin.
_child: subprocess.Popen[str] | None = None
_child_lock = threading.Lock()
_restart_delay_s = 1.0


def _send(cmd: dict) -> None:
    """Send one command to the child, starting it if needed. A child that
    died mid-write is restarted by its reader, which re-adds every watch."""
    global _child
    with _child_lock:
        if _child is None:
            _child = _spawn()
        try:
            assert _child.stdin is not None
            _child.stdin.write(json.dumps(cmd) + "\n")
            _child.stdin.flush()
        except OSError:
            pass


def _spawn() -> subprocess.Popen[str]:
    proc = subprocess.Popen(
        [sys.executable, "-m", "moire.services.watch_proc"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        # Out of the terminal's process group, so a Ctrl+C (or a dev
        # runner's group signal) stops only the server; the child ends on
        # stdin EOF once `stop_all` (or the server's exit) closes it.
        start_new_session=os.name != "nt",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if os.name == "nt"
        else 0,
    )
    threading.Thread(
        target=_read_child, args=(proc,), name="watch-child-reader", daemon=True
    ).start()
    return proc


def _read_child(proc: subprocess.Popen[str]) -> None:
    global _child, _restart_delay_s
    started = time.monotonic()
    assert proc.stdout is not None
    for line in proc.stdout:
        # One bad line must not end routing (and restarts) for every library.
        try:
            _route(json.loads(line))
        except Exception:
            logger.exception("bad message from watcher process: %r", line[:200])
    proc.wait()
    with _child_lock:
        if _child is not proc:
            return  # stopped on purpose (stop_all)
        _child = None
    # Back off a child that keeps dying young; reconciliation covers the gap.
    lived = time.monotonic() - started
    _restart_delay_s = 1.0 if lived > 60 else min(_restart_delay_s * 2, 60.0)
    logger.warning(
        "watcher process exited code=%s; restarting in %.0fs",
        proc.returncode,
        _restart_delay_s,
    )
    time.sleep(_restart_delay_s)
    with _lock:
        ws = list(_watches.values())
    for w in ws:
        _send_add(w)


def _route(msg: dict) -> None:
    with _lock:
        w = _by_key.get(str(msg.get("key")))
    if w is None:
        return
    if "error" in msg:
        # The root vanished (drive unplugged, share dropped) or watchfiles
        # hit a platform error. The reconciliation timer (and a future
        # add/rescan) is the recovery path, as before.
        logger.error(
            "watch loop exited unexpectedly library=%s\n%s",
            w.library_id,
            msg["error"],
        )
    else:
        w.queue.put({(Change(c), p) for c, p in msg.get("changes", ())})


def _send_add(w: _Watch) -> None:
    _send(
        {
            "op": "add",
            "key": w.key,
            "path": str(w.root),
            "debounce_ms": max(50, settings.watch_debounce_ms),
        }
    )


def _is_ignored(path: Path) -> bool:
    name = path.name
    if name.startswith(".") or name.startswith("~"):
        return True
    return path.suffix.lower() in _IGNORED_SUFFIXES


def _wait_stable(path: Path, stop_event: threading.Event) -> bool:
    """Block (briefly) until `path`'s size stops changing, or give up.

    Returns False if the file vanished, never stabilized, or a stop was
    requested mid-wait (library deleted / watching disabled), callers treat
    all three as "skip, the periodic reconciliation will catch it eventually"
    (a live stop propagates immediately rather than blocking shutdown for the
    full stability window).
    """
    window_s = max(0.05, settings.watch_stability_window_ms / 1000.0)
    attempts = max(1, settings.watch_stability_max_attempts)
    last_size = -1
    for _ in range(attempts):
        if stop_event.is_set():
            return False
        try:
            size = path.stat().st_size
        except OSError:
            return False
        if size == last_size:
            return True
        last_size = size
        stop_event.wait(window_s)
    return False


def _run_watch(w: _Watch) -> None:
    while True:
        changes = w.queue.get()
        if changes is None or w.stop_event.is_set():
            break
        for change, raw_path in changes:
            if w.stop_event.is_set():
                break
            if scanner.is_scanning(w.library_id):
                # A full scan already reflects (or will reflect) disk state
                # as of its own walk; let it own this pass instead of racing
                # it. Checked per-change (not once per debounced batch) so a
                # scan that starts mid-batch still stops the rest of it.
                continue
            path = Path(raw_path)
            if _is_ignored(path):
                continue
            # A library inside this one watches its own folder.
            if library_nesting.owned_by_nested(w.library_id, w.root, path):
                continue
            try:
                if change == Change.deleted:
                    image_id = scanner.image_id_for(w.library_id, w.root, path)
                    scanner.remove_single_image(w.library_id, image_id)
                else:
                    if not path.is_file() or not scanner.is_image(path):
                        continue
                    if not _wait_stable(path, w.stop_event):
                        continue
                    scanner.ingest_single_file(w.library_id, w.root, path)
            except Exception:
                logger.exception(
                    "watch event failed library=%s change=%s path=%s",
                    w.library_id,
                    change,
                    raw_path,
                )


def _schedule_reconcile(w: _Watch) -> None:
    interval = max(60, settings.watch_reconcile_interval_s)

    def _tick() -> None:
        if w.stop_event.is_set():
            return
        try:
            # An unplugged drive or dropped share must never look like "every
            # file was deleted": `scan_library_async`'s stale-reconciliation
            # treats a walk that finds nothing as authoritative and would wipe
            # the library's rows and thumbnails. Skip the reconcile pass
            # entirely until the root is reachable again.
            if w.root.is_dir() and not scanner.is_scanning(w.library_id):
                scanner.scan_library_async(w.library_id, str(w.root))
        finally:
            if not w.stop_event.is_set():
                _schedule_reconcile(w)

    w.reconcile_timer = threading.Timer(interval, _tick)
    w.reconcile_timer.daemon = True
    w.reconcile_timer.start()


def start_watch(library_id: str, path: str) -> None:
    """Start (or restart) watching `path` for `library_id`. Idempotent.

    The stop-old-then-install-new sequence holds `_lock` for its full
    duration (including the old watcher's `join`), not just the dict swap:
    two calls for the same `library_id` racing (startup vs. a concurrent PATCH)
    would otherwise both read no existing watcher, then both write, leaking
    the loser's thread with a `stop_event` nothing will ever set again.
    """
    root = Path(path)
    with _lock:
        existing = _watches.pop(library_id, None)
        if existing is not None:
            _by_key.pop(existing.key, None)
            _stop(existing)

        w = _Watch(library_id, root)
        th = threading.Thread(
            target=_run_watch, args=(w,), name=f"watch-{library_id}", daemon=True
        )
        w.thread = th
        _watches[library_id] = w
        _by_key[w.key] = w
        th.start()
        _send_add(w)
    _schedule_reconcile(w)


def _stop(w: _Watch) -> None:
    w.stop_event.set()
    if w.reconcile_timer is not None:
        w.reconcile_timer.cancel()
    _send({"op": "remove", "key": w.key})
    w.queue.put(None)
    if w.thread is not None and w.thread.is_alive():
        w.thread.join(timeout=1.0)


def stop_watch(library_id: str) -> None:
    with _lock:
        w = _watches.pop(library_id, None)
        if w is not None:
            _by_key.pop(w.key, None)
    if w is not None:
        _stop(w)


def stop_all() -> None:
    global _child
    with _lock:
        ws = list(_watches.values())
        _watches.clear()
        _by_key.clear()
    for w in ws:
        _stop(w)
    with _child_lock:
        proc, _child = _child, None
    if proc is not None:
        # EOF on its stdin stops the child; kill it if it doesn't go.
        try:
            assert proc.stdin is not None
            proc.stdin.close()
            proc.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()


def is_watching(library_id: str) -> bool:
    with _lock:
        return library_id in _watches
