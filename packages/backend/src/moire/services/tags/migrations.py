"""One-off data migrations, run once each at startup (before the AI worker and
the watchers start) and recorded in the ``app_settings`` row "migrations".

An entry is ``(name, data step or None, needs a full reprojection after)``.
Each runs once; names are recorded only after the run's reprojection, so an
interrupted run is redone, and a step must be idempotent. A prompt-parser
change that alters what is extracted is a reprojection-only entry
``(name, None, True)``: raw prompts are untouched, only what is derived from
them is rebuilt, and however many are pending, one reprojection covers them.

A new column needs no entry: ``ensure_schema`` adds it to an existing table.
The list starts empty at the first release (the steps before it only ever
met development databases); a new install records nothing and its first scan
derives everything.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from .. import app_settings
from . import index as tag_index
from ..metadata import reproject

logger = logging.getLogger("moire.migrations")

_ROW = "migrations"

_MIGRATIONS: tuple[tuple[str, Callable[[], None] | None, bool], ...] = ()


def _done() -> dict[str, Any]:
    return dict(app_settings.read_sync(_ROW) or {})


def _mark(name: str) -> None:
    doc = {**_done(), name: time.time()}
    app_settings.write_sync(_ROW, doc)


def run_pending() -> None:
    """Run every migration not yet recorded. Sync: call off the event loop."""
    done = _done()
    pending = [m for m in _MIGRATIONS if m[0] not in done]
    if not pending:
        return
    for _name, step, _reproject in pending:
        if step is not None:
            step()
    if any(needs for _n, _s, needs in pending):
        started = time.monotonic()
        # Forced: a step may have added a derived table that unchanged gen
        # data must still be written into.
        reprojected = reproject.reproject_all(force=True)
        logger.info(
            "migrations %s: reprojected %d images in %.1fs",
            ", ".join(n for n, _s, _r in pending),
            reprojected,
            time.monotonic() - started,
        )
    tag_index.invalidate()
    for name, _step, _reproject in pending:
        _mark(name)
