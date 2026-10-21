"""Filesystem watcher child process: `python -m moire.services.watch_proc`.

watchfiles' `RustNotify` walks the whole tree when it starts (inotify watches,
or a full stat pass when polling, which watchfiles forces on WSL) and holds
the GIL for that whole walk. With dozens of libraries on a slow mount that
froze the server for 10 to 30 s at every boot. Here it only stalls this
process; `library_watch` in the server keeps its threads responsive.

Imports nothing from Moiré beyond the package itself (no DB, no settings).

Protocol, one JSON object per line:
  stdin   {"op": "add", "key": k, "gen": g, "path": p, "debounce_ms": n}
          {"op": "remove", "key": k}
  stdout  {"key": k, "gen": g, "changes": [[change, path], ...]}
          {"key": k, "gen": g, "error": "..."}  (the watch loop died)
An add replaces the key's watch; `gen` is echoed so the server can drop
batches from the one it replaced. `change` is watchfiles' `Change` value.
EOF on stdin (the server exited) stops everything.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import traceback

from watchfiles import watch

_out_lock = threading.Lock()
_stops: dict[str, threading.Event] = {}


def _emit(msg: dict) -> None:
    line = json.dumps(msg)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _run(
    key: str, gen: int, path: str, debounce_ms: int, stop: threading.Event
) -> None:
    try:
        for changes in watch(path, debounce=debounce_ms, stop_event=stop):
            if stop.is_set():
                break
            _emit(
                {
                    "key": key,
                    "gen": gen,
                    "changes": [[int(c), p] for c, p in changes],
                }
            )
    except BaseException:  # a Rust panic arrives as a BaseException
        if not stop.is_set():
            _emit({"key": key, "gen": gen, "error": traceback.format_exc()})


def main() -> None:
    # Ctrl+C is the server's to handle (Windows sends it to the whole
    # console); this process stops on stdin EOF.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    for line in sys.stdin:
        try:
            cmd = json.loads(line)
        except ValueError:
            continue
        key = str(cmd.get("key"))
        old = _stops.pop(key, None)
        if old is not None:
            old.set()
        if cmd.get("op") == "add":
            stop = threading.Event()
            _stops[key] = stop
            threading.Thread(
                target=_run,
                args=(
                    key,
                    cmd.get("gen"),
                    cmd["path"],
                    int(cmd.get("debounce_ms", 800)),
                    stop,
                ),
                name=f"watch-{key}",
                daemon=True,
            ).start()
    # Exit now rather than stopping each watcher: closing one joins its
    # polling thread mid-walk, ~25 s for 42 roots on a slow mount.
    os._exit(0)


if __name__ == "__main__":
    main()
