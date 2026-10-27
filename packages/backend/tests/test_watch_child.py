"""The watcher child's supervisor against a fake process: a first command
spawns the child and replays the current adds once, and a stale add is
never written."""

import io
import json
import threading
import time

from moire.services.watch_child import ChildWatcher


class _FakeProc:
    def __init__(self):
        self.stdin = io.StringIO()
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def lines(self):
        return [json.loads(x) for x in self.stdin.getvalue().splitlines()]


def _wait(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def test_spawn_replays_adds_and_skips_stale_ones():
    lock = threading.Lock()
    live = {"A": 1}
    procs: list[_FakeProc] = []
    child = ChildWatcher(
        ["unused"],
        lock=lock,
        on_message=lambda _m: None,
        current_adds=lambda: [
            {"op": "add", "key": k, "gen": g} for k, g in live.items()
        ],
        is_current=lambda c: live.get(c["key"]) == c["gen"],
        wanted=lambda: bool(live),
    )

    def spawn(_closing):
        procs.append(_FakeProc())
        return procs[-1]

    child.spawn = spawn
    with lock:
        child.send({"op": "add", "key": "A", "gen": 1})  # also in the replay
        child.send({"op": "add", "key": "B", "gen": 7})  # never current
        child.send({"op": "remove", "key": "A"})
    assert _wait(lambda: procs and len(procs[0].lines()) == 2)
    assert len(procs) == 1
    assert procs[0].lines() == [
        {"op": "add", "key": "A", "gen": 1},
        {"op": "remove", "key": "A"},
    ]
    with lock:
        writer = child.detach()
    ChildWatcher.close(writer)
    assert procs[0].stdin.closed
