"""Keeps one JSON-lines child process alive for library_watch: spawns it,
writes it commands, reads its messages, restarts it with backoff when it
dies young, and replays the current adds into each new child.

It knows nothing of libraries: the caller hands in the shared lock, where
messages go, what to re-add on a respawn, whether a queued add is still
current, and whether a child is wanted at all.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
import time
from collections.abc import Callable

logger = logging.getLogger("moire.watch")


class ChildWatcher:
    """The child's supervisor. ``lock`` is the caller's: hold it around
    `send` and `detach`; the callbacks are called with it held
    (``current_adds``, ``wanted``) or without it (``is_current``,
    ``on_message``) and must not take it themselves."""

    def __init__(
        self,
        argv: list[str],
        *,
        lock: threading.Lock,
        on_message: Callable[[dict], None],
        current_adds: Callable[[], list[dict]],
        is_current: Callable[[dict], bool],
        wanted: Callable[[], bool],
    ) -> None:
        self.argv = argv
        self.lock = lock
        self.on_message = on_message
        self.current_adds = current_adds
        self.is_current = is_current
        self.wanted = wanted
        # Commands for the child, written by one thread that owns it, so
        # callers (holding `lock`, often on the event loop) never block on its
        # stdin and a respawn's re-adds stay ordered with every start/stop
        # around them. Each writer has its own queue: `detach` retires it, and
        # a later `send` starts a fresh one, so nothing queued around a close
        # is lost or replayed.
        self._writer: _Writer | None = None
        # Restart backoff for a child that keeps dying young.
        self.restart_delay_s = 1.0
        self.respawn_at = 0.0

    def send(self, cmd: dict) -> None:
        """Queue one command for the child. Call with `lock` held."""
        if self._writer is None or not self._writer.thread.is_alive():
            self._writer = _Writer(self)
            self._writer.thread.start()
        self._writer.cmds.put(cmd)

    def detach(self) -> _Writer | None:
        """Retire the current writer (call with `lock` held); close it with
        `close` once the lock is released."""
        writer, self._writer = self._writer, None
        return writer

    @staticmethod
    def close(writer: _Writer | None, timeout: float = 5) -> None:
        """Stop a detached writer and its child, waiting up to ``timeout``."""
        if writer is not None and writer.thread.is_alive():
            done = threading.Event()
            writer.cmds.put({"op": "close", "done": done})
            done.wait(timeout=timeout)

    def spawn(self, closing: threading.Event) -> subprocess.Popen[str]:
        proc = subprocess.Popen(
            self.argv,
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
            target=self._read_child,
            args=(proc, closing),
            name="watch-child-reader",
            daemon=True,
        ).start()
        return proc

    def back_off(self, lived_s: float) -> float:
        if lived_s > 60:
            self.restart_delay_s = 1.0
        delay = self.restart_delay_s
        self.restart_delay_s = min(delay * 2, 60.0)
        self.respawn_at = time.monotonic() + delay
        return delay

    def _read_child(
        self, proc: subprocess.Popen[str], closing: threading.Event
    ) -> None:
        started = time.monotonic()
        assert proc.stdout is not None
        for line in proc.stdout:
            # One bad line must not end routing (and restarts) for every library.
            try:
                self.on_message(json.loads(line))
            except Exception:
                logger.exception("bad message from watcher process: %r", line[:200])
        proc.wait()
        if closing.is_set():
            return
        # Reconciliation covers the gap until the new child is up.
        delay = self.back_off(time.monotonic() - started)
        logger.warning(
            "watcher process exited code=%s; restarting in %.0fs",
            proc.returncode,
            delay,
        )
        with self.lock:
            # None wanted (stop_all): the next send starts a child.
            if self.wanted():
                self.send({"op": "respawn"})


class _Writer:
    """One writer thread, its command queue and the child it owns."""

    def __init__(self, owner: ChildWatcher) -> None:
        self.owner = owner
        self.cmds: queue.Queue[dict] = queue.Queue()
        self.thread = threading.Thread(
            target=self.run, name="watch-child-writer", daemon=True
        )
        self.proc: subprocess.Popen[str] | None = None
        self.closing = threading.Event()
        self.readded: set[int] = set()
        # Without a child, commands are dropped: the respawn re-adds every
        # current watch, which already reflects them.
        self.want_child = False

    def run(self) -> None:
        while True:
            cmd = self._next()
            if cmd["op"] == "close":
                if self.proc is not None:
                    self.closing.set()
                    _close(self.proc)
                cmd["done"].set()
                return
            # One bad command must not end the writer: a new one would start
            # a second child beside this one.
            try:
                self._handle(cmd)
            except Exception:
                logger.exception("watcher command failed: %r", cmd)

    def _next(self) -> dict:
        timeout = None
        if self.want_child:
            timeout = max(0.0, self.owner.respawn_at - time.monotonic())
        try:
            return self.cmds.get(timeout=timeout)
        except queue.Empty:
            return {"op": "respawn"}

    def _handle(self, cmd: dict) -> None:
        op = cmd["op"]
        if self.proc is not None and self.proc.poll() is not None:
            self.proc = None  # died; its reader queued a respawn
        if self.proc is None and (op == "remove" or not self._start_child()):
            return
        if op == "respawn":
            return
        # Sent with the respawn's re-adds, or replaced since it was queued
        # (writing it would put the old root back).
        if op == "add" and (
            cmd["gen"] in self.readded or not self.owner.is_current(cmd)
        ):
            return
        assert self.proc is not None
        _write(self.proc, cmd)

    def _start_child(self) -> bool:
        """Spawn the child and replay every current add into it; False while
        backing off or when it couldn't start."""
        if time.monotonic() < self.owner.respawn_at:
            self.want_child = True  # backing off; the get in _next times out
            return False
        self.want_child = False
        self.closing = threading.Event()
        try:
            self.proc = self.owner.spawn(self.closing)
        except Exception:
            logger.exception("could not start the watcher process")
            self.owner.back_off(0.0)
            self.want_child = True
            return False
        with self.owner.lock:
            adds = self.owner.current_adds()
        self.readded = {c["gen"] for c in adds}
        for c in adds:
            _write(self.proc, c)
        return True


def _write(proc: subprocess.Popen[str], cmd: dict) -> None:
    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(cmd) + "\n")
        proc.stdin.flush()
    except (OSError, ValueError):
        pass  # it died; its reader queues a respawn


def _close(proc: subprocess.Popen[str]) -> None:
    # EOF on its stdin stops the child; kill it if it doesn't go.
    try:
        assert proc.stdin is not None
        proc.stdin.close()
        proc.wait(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        proc.kill()
        proc.wait()
