"""Per-library filesystem watcher: near-real-time incremental indexing.

Hybrid model (see docs/phase-functional-features.md #4): this module gives the
"near real-time" half: a `watchfiles` thread per watched library that feeds
bursts of adds/modifies/deletes to `scan_incremental.ingest_files` /
`scan_incremental.remove_images`. The "periodic reconciliation" half is just the
existing full `scan_library_async`, re-run on a timer here as a backstop for
events a watcher misses (network shares, drives that don't deliver
inotify/ReadDirectoryChanges reliably, the process being down when a change
happened).

The watching itself (`watchfiles`, which debounces bursts into batches) runs
in one child process, `watch_proc`: watchfiles holds the GIL while it walks a
new root, which froze the server for the whole walk (10 to 30 s at boot with
dozens of libraries on a slow mount); `watch_child.ChildWatcher` keeps it
alive. One thread per library here takes that library's batches off a queue.
Debounced batches still name files that may be mid-write (a generator tool
still streaming bytes to disk), so a changed file waits in a pending set until
its size and mtime hold for one stability window. The whole set shares that
wait: every file that held still is ingested together as one batch, and a file
still growing stays pending for a later pass.
"""

from __future__ import annotations

import itertools
import logging
import queue
import stat
import sys
import threading
import time
from pathlib import Path

from watchfiles import Change

from ...core.config import settings
from . import nesting as library_nesting, scan_incremental, scanner, thumbnailer
from .watch_child import ChildWatcher

logger = logging.getLogger("moire.watch")


class _Watch:
    __slots__ = (
        "library_id",
        "root",
        "gen",
        "queue",
        "stop_event",
        "thread",
        "reconcile_timer",
    )

    def __init__(self, library_id: str, root: Path) -> None:
        self.library_id = library_id
        self.root = root
        # Echoed back by the child, so a restarted watch never gets batches
        # still in flight for the root it replaced.
        self.gen = next(_gens)
        # Batches of (Change, path) from the child; None ends the thread.
        self.queue: queue.Queue[set[tuple[Change, str]] | None] = queue.Queue()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.reconcile_timer: threading.Timer | None = None


_gens = itertools.count(1)
_lock = threading.Lock()
_watches: dict[str, _Watch] = {}


def _add_cmd(w: _Watch) -> dict:
    return {
        "op": "add",
        "key": w.library_id,
        "gen": w.gen,
        "path": str(w.root),
        "debounce_ms": max(50, settings.watch_debounce_ms),
        "poll_delay_ms": max(50, settings.watch_poll_delay_ms),
    }


def _route(msg: dict) -> None:
    # No `_lock`: start_watch holds it across a join, and routing for every
    # library would stall behind it. A dict read is atomic.
    w = _watches.get(str(msg.get("key")))
    if w is None or w.gen != msg.get("gen"):
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


def _is_current(cmd: dict) -> bool:
    """Whether a queued add is still the library's watch (not replaced)."""
    w = _watches.get(cmd["key"])
    return w is not None and w.gen == cmd["gen"]


_child = ChildWatcher(
    [sys.executable, "-m", "moire.services.library.watch_proc"],
    lock=_lock,
    on_message=_route,
    # The respawn re-adds every live watch.
    current_adds=lambda: [_add_cmd(w) for w in _watches.values()],
    is_current=_is_current,
    wanted=lambda: bool(_watches),
)


# A file's (size, mtime_ns) and when the watcher last saw it change.
_Seen = tuple[tuple[int, int], float]


def _snapshot(path: Path) -> tuple[int, int] | None:
    """(size, mtime_ns) of a regular file, None if it is gone or not a file."""
    try:
        st = path.stat()
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    return st.st_size, st.st_mtime_ns


def _window_s() -> float:
    return max(0.05, settings.watch_stability_window_ms / 1000.0)


def _take_stable(pending: dict[Path, _Seen | None], window_s: float) -> list[Path]:
    """Re-stat every pending file; pop and return those that held their size
    and mtime for a full window. A file still changing stays pending with its
    new snapshot (retried on a later pass, never dropped); one that vanished
    is dropped (its delete event, if any, removes the row)."""
    now = time.monotonic()
    ready: list[Path] = []
    for path, seen in list(pending.items()):
        sig = _snapshot(path)
        if sig is None:
            del pending[path]
        elif seen is None or seen[0] != sig:
            pending[path] = (sig, now)
        elif now - seen[1] >= window_s:
            del pending[path]
            ready.append(path)
    return ready


def _next_wait(pending: dict[Path, _Seen | None], window_s: float) -> float | None:
    """How long the watch thread may block for new events: until the oldest
    pending file's window ends, or indefinitely with nothing pending."""
    if not pending:
        return None
    if any(seen is None for seen in pending.values()):
        return 0.0
    oldest = min(seen[1] for seen in pending.values() if seen is not None)
    due = oldest + window_s - time.monotonic()
    # Overdue only while a scan holds the files back: look again in a
    # window, not in a busy loop for the whole scan.
    return due if due > 0 else window_s


def _note_changes(
    w: _Watch, changes: set[tuple[Change, str]], pending: dict[Path, _Seen | None]
) -> list[str]:
    """Sort one merged batch by what is on disk now (a merged set has lost
    the events' order, so a delete-then-recreate reads as an add): files to
    wait on go into ``pending`` (a fresh event restarts their window),
    vanished paths come back as image ids to remove."""
    gone: list[str] = []
    for raw_path in {p for _c, p in changes}:
        path = Path(raw_path)
        if thumbnailer.is_ignored(path):
            continue
        # A library inside this one watches its own folder.
        if library_nesting.owned_by_nested(w.library_id, w.root, path):
            continue
        if path.is_file():
            if thumbnailer.is_image(path):
                pending[path] = None
        elif not path.exists():
            pending.pop(path, None)
            try:
                gone.append(scanner.image_id_for(w.library_id, w.root, path))
            except ValueError:
                logger.debug("watch path outside its root: %s", raw_path)
    return gone


def _process(
    w: _Watch,
    changes: set[tuple[Change, str]],
    pending: dict[Path, _Seen | None],
    window_s: float,
) -> None:
    """Apply one merged batch: removals at once, then every pending file that
    has held still for a window, ingested together."""
    if scanner.is_scanning(w.library_id):
        # A full scan already reflects (or will reflect) disk state as of its
        # own walk; let it own these events instead of racing it. Files
        # already pending wait for it to end (an upsert after it is harmless).
        return
    gone = _note_changes(w, changes, pending) if changes else []
    if gone:
        try:
            scan_incremental.remove_images(w.library_id, gone)
        except Exception:
            logger.exception(
                "watch removal failed library=%s count=%d", w.library_id, len(gone)
            )
    ready = _take_stable(pending, window_s)
    if not ready or w.stop_event.is_set() or scanner.is_scanning(w.library_id):
        # Not lost: a stop ends the watch, and a scan started meanwhile walks
        # these files itself.
        return
    try:
        written = scan_incremental.ingest_files(
            w.library_id,
            w.root,
            sorted(ready),
            is_cancelled=lambda: (
                w.stop_event.is_set() or scanner.is_scanning(w.library_id)
            ),
        )
    except Exception:
        logger.exception(
            "watch ingest failed library=%s count=%d", w.library_id, len(ready)
        )
        return
    if written:
        scanner.nudge_auto_tag()


def _run_watch(w: _Watch) -> None:
    # Files seen changing that have not yet held still for a window.
    pending: dict[Path, _Seen | None] = {}
    while True:
        window_s = _window_s()
        try:
            changes = w.queue.get(timeout=_next_wait(pending, window_s))
        except queue.Empty:
            changes = set()  # a pending file's window is up
        # Merge batches that queued up during a slow ingest, as watchfiles
        # did in-process, so a file rewritten in a burst is ingested once.
        while changes is not None:
            try:
                more = w.queue.get_nowait()
            except queue.Empty:
                break
            changes = None if more is None else changes | more
        if changes is None or w.stop_event.is_set():
            break
        try:
            _process(w, changes, pending, window_s)
        except Exception:
            logger.exception("watch batch failed library=%s", w.library_id)


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
            _stop(existing)

        w = _Watch(library_id, root)
        th = threading.Thread(
            target=_run_watch, args=(w,), name=f"watch-{library_id}", daemon=True
        )
        w.thread = th
        _watches[library_id] = w
        th.start()
        # Replaces the child's watch for this library, if any.
        _child.send(_add_cmd(w))
    _schedule_reconcile(w)


def _signal_stop(w: _Watch) -> None:
    w.stop_event.set()
    if w.reconcile_timer is not None:
        w.reconcile_timer.cancel()
    w.queue.put(None)


def _stop(w: _Watch) -> None:
    _signal_stop(w)
    if w.thread is not None and w.thread.is_alive():
        w.thread.join(timeout=1.0)


def stop_watch(library_id: str) -> None:
    with _lock:
        w = _watches.pop(library_id, None)
        if w is not None:
            _child.send({"op": "remove", "key": library_id})
    if w is not None:
        _stop(w)


def stop_all() -> None:
    with _lock:
        ws = list(_watches.values())
        _watches.clear()
        writer = _child.detach()
    # Signal every watch first, then join them against one deadline.
    for w in ws:
        _signal_stop(w)
    deadline = time.monotonic() + 2.0
    for w in ws:
        if w.thread is not None:
            w.thread.join(timeout=max(0.0, deadline - time.monotonic()))
    _child.close(writer)


def is_watching(library_id: str) -> bool:
    with _lock:
        return library_id in _watches
