"""Background work the UI should see while it runs.

Work with its own state elsewhere (a library's scan columns, AI jobs, model
downloads, face detection) is read where it lives by ``api/activity``. This
registry is for the rest: work that otherwise leaves no trace until it ends,
such as deleting a library or re-reading prompts. Thread-safe; the scanner's
and reprojection's threads write to it as well as the event loop.
"""

from __future__ import annotations

import itertools
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

_lock = threading.Lock()
_tasks: dict[int, "Task"] = {}
_ids = itertools.count(1)


@dataclass
class Task:
    kind: str
    library_id: str | None = None
    total: int | None = None
    done: int = 0
    started_at: float = field(default_factory=time.time)

    def advance(self, n: int = 1) -> None:
        with _lock:
            self.done += n

    def add_total(self, n: int) -> None:
        with _lock:
            self.total = (self.total or 0) + n


@contextmanager
def track(
    kind: str, *, library_id: str | None = None, total: int | None = None
) -> Iterator[Task]:
    """Show ``kind`` of work (on ``library_id``) as running until the block
    exits, however it exits."""
    task = Task(kind, library_id, total)
    with _lock:
        key = next(_ids)
        _tasks[key] = task
    try:
        yield task
    finally:
        with _lock:
            _tasks.pop(key, None)


def snapshot() -> list[dict[str, Any]]:
    """The running tasks, oldest first."""
    with _lock:
        return [
            {
                "key": f"{task.kind}:{key}",
                "kind": task.kind,
                "library_id": task.library_id,
                "done": task.done,
                "total": task.total,
            }
            for key, task in sorted(_tasks.items())
        ]


def running(kind: str) -> set[str]:
    """The libraries with ``kind`` of work running on them."""
    with _lock:
        return {
            task.library_id
            for task in _tasks.values()
            if task.kind == kind and task.library_id
        }
