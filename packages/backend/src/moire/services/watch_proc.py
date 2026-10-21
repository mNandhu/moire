"""Filesystem watcher child process: `python -m moire.services.watch_proc`.

watchfiles' `RustNotify` walks the whole tree when it starts (inotify watches,
or a full stat pass when polling, which watchfiles forces on WSL) and holds
the GIL for that whole walk. With dozens of libraries on a slow mount that
froze the server for 10 to 30 s at every boot. Here it only stalls this
process; `library_watch` in the server keeps its threads responsive.

Imports nothing from Moiré beyond the package itself (no DB, no settings).

Protocol, one JSON object per line:
  stdin   {"op": "add", "key": k, "path": p, "debounce_ms": n}
          {"op": "remove", "key": k}
  stdout  {"key": k, "changes": [[change, path], ...]}
          {"key": k, "error": "..."}  (the watch loop died; it is not retried)
`change` is watchfiles' `Change` value. EOF on stdin (the server exited) stops
everything.
"""

from __future__ import annotations

import json
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


def _run(key: str, path: str, debounce_ms: int, stop: threading.Event) -> None:
    try:
        for changes in watch(path, debounce=debounce_ms, stop_event=stop):
            if stop.is_set():
                break
            _emit({"key": key, "changes": [[int(c), p] for c, p in changes]})
    except Exception:
        if not stop.is_set():
            _emit({"key": key, "error": traceback.format_exc()})


def main() -> None:
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
                args=(key, cmd["path"], int(cmd.get("debounce_ms", 800)), stop),
                name=f"watch-{key}",
                daemon=True,
            ).start()
    for stop in _stops.values():
        stop.set()


if __name__ == "__main__":
    main()
