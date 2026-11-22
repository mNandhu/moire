"""Reprojection's CPU work, off the API process: decoding each raw row's JSON
and :func:`gen_metadata.derive`, ~30 s of pure Python at 30k images. In a
thread of the API process it holds the GIL, and every request waits behind
it (a thumbnail read 35 -> 300 ms at p95). Here it runs in one worker
process (one: the scanner and the AI tagger need the other cores), started
on the first big page, kept for later runs, and stopped when idle.

The worker imports only this module and what :mod:`gen_metadata` needs, not
the app: it is spawned (no fork, so the same on Windows), gets plain values
(never :class:`ExtractionConfig`, whose module loads the database and
settings) and sends back each row's stored ``gen``. Anything wrong with the
pool (it can't start, the worker died) makes :func:`derive_page` say so, and
the caller derives in its own thread instead.

Spawn imports the parent's main script in the worker, as every
multiprocessing spawn does: a script that starts the app must keep its work
under ``if __name__ == "__main__":`` (the ``moire`` and ``uvicorn`` commands
do)."""

from __future__ import annotations

import json
import logging
import multiprocessing
import multiprocessing.connection
import os
import signal
import threading
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass
from typing import Any

from . import gen_metadata
from .prompt_guess import Keywords

logger = logging.getLogger("moire.reproject")

# Off: every page is derived in the caller's thread (the tests, which patch
# `gen_metadata` in-process, turn it off).
ENABLED = True
# A page smaller than this is derived in the caller's thread: a watcher's one
# image or a small rule change holds the GIL for milliseconds, not worth a
# round trip (or the worker's start).
MIN_ROWS = 50
# The worker exits after this long without a page.
IDLE_S = 120.0

# One raw row as read: (image id, library id, workflow signature, raw JSON text).
Row = tuple[str, str | None, str | None, str | None]
# One row's result: (image id, stored gen or None, error or None). A row with
# an error is skipped and not stamped, so it is tried again next run.
Result = tuple[str, "dict | None", "str | None"]


@dataclass(frozen=True)
class Config:
    """What :func:`gen_metadata.derive` reads of an ``ExtractionConfig``, as
    plain values the worker can unpickle without the app."""

    keywords: Keywords
    positive_only: bool
    rules: dict[str, list[str]]

    @classmethod
    def of(cls, config: Any) -> Config:
        return cls(config.keywords, config.positive_only, config.rules)


def derive_rows(
    rows: list[Row], rulesets: dict[str, dict], config: Any
) -> list[Result]:
    """Each row's ``gen`` as stored (JSON round trip, so it compares equal
    to what is read back). Runs in the worker, or in the caller's thread."""
    out: list[Result] = []
    for image_id, library_id, sig, raw in rows:
        try:
            doc = json.loads(raw) if raw else {}
            g = gen_metadata.derive(
                {
                    "_id": image_id,
                    "library_id": library_id,
                    "workflow_sig": sig,
                    **(doc or {}),
                },
                rulesets.get(sig) if sig is not None else None,
                config,
            )
            out.append(
                (image_id, None if g is None else json.loads(json.dumps(g)), None)
            )
        except Exception as e:
            # One hostile graph (or raw) must not leave every later row
            # underived.
            out.append((image_id, None, repr(e)))
    return out


def _init_worker() -> None:
    # A Ctrl+C in the terminal reaches the whole process group: the server
    # stops the worker itself (or the worker ends with the server's pipe).
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    # A server killed outright (SIGKILL, a crash) never stops the pool, and
    # the worker would wait on its queue forever: end with the parent.
    parent = multiprocessing.parent_process()
    if parent is not None:
        threading.Thread(
            target=_exit_with, args=(parent.sentinel,), daemon=True
        ).start()


def _exit_with(sentinel: int) -> None:
    multiprocessing.connection.wait([sentinel])
    os._exit(0)


_lock = threading.Lock()
_pool: ProcessPoolExecutor | None = None
_closed = False  # shut down with the app: no new worker
_warned = False
# Worker failures so far, and whether it was given up on (every page derived
# in-thread for the rest of the process): one that fails every time is not
# started again for each pass of a run (each id chunk is one).
MAX_FAILURES = 2
_failures = 0
_disabled = False
_idle: threading.Timer | None = None
_users = 0


class Unavailable(Exception):
    """The worker can't take the page: derive it in-thread."""


def _get_pool() -> ProcessPoolExecutor:
    global _pool
    with _lock:
        if _closed:
            raise Unavailable("shut down")
        if _disabled:
            raise Unavailable("given up on")
        if _pool is None:
            _pool = ProcessPoolExecutor(
                max_workers=1,
                mp_context=multiprocessing.get_context("spawn"),
                initializer=_init_worker,
            )
            logger.info("Reprojection derives in a worker process")
        return _pool


def broken(err: BaseException) -> None:
    """The worker failed (died, couldn't start): drop it, so the next pass
    starts a fresh one, until it has failed :data:`MAX_FAILURES` times;
    then it is given up on for the rest of the process. Call it once per
    pass (pages already sent fail with it). Logged once per process, and
    once more when given up on."""
    global _pool, _warned, _failures, _disabled
    give_up = False
    with _lock:
        pool, _pool = _pool, None
        # A shutdown cancels a run's pages: no failure to report.
        warn = not _warned and not _closed
        _warned = _warned or warn
        if not _closed and not _disabled:
            _failures += 1
            give_up = _disabled = _failures >= MAX_FAILURES
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)
    if warn:
        logger.warning(
            "Reprojection worker process failed (%r): deriving in-thread", err
        )
    if give_up:
        logger.warning(
            "Reprojection worker process given up on after %d failures: "
            "deriving in-thread until restart",
            _failures,
        )


def submit(rows: list[Row], rulesets: dict[str, dict], config: Any) -> Future:
    """Send one page to the worker. Raises :class:`Unavailable` when it
    can't take it (the caller derives in-thread)."""
    used = {r[2] for r in rows}
    page_rulesets = {sig: doc for sig, doc in rulesets.items() if sig in used}
    try:
        return _get_pool().submit(derive_rows, rows, page_rulesets, Config.of(config))
    except Unavailable:
        raise
    except Exception as e:
        broken(e)
        raise Unavailable(repr(e)) from e


def use(n_rows: int) -> bool:
    """Whether a page of ``n_rows`` goes to the worker."""
    return ENABLED and not _closed and not _disabled and n_rows >= MIN_ROWS


def run_started() -> None:
    """A run may use the worker: hold off the idle stop until it ends."""
    global _users, _idle
    with _lock:
        _users += 1
        if _idle is not None:
            _idle.cancel()
            _idle = None


def run_ended() -> None:
    """A run ended: stop the worker once nothing used it for ``IDLE_S``
    (it holds the last pages' memory)."""
    global _users, _idle
    with _lock:
        _users -= 1
        if _users or _pool is None or _closed:
            return
        timer = threading.Timer(IDLE_S, _stop_if_idle)
        timer.args = (timer,)
        timer.daemon = True
        _idle = timer
        timer.start()


def _stop_if_idle(timer: threading.Timer) -> None:
    global _pool, _idle
    with _lock:
        # A timer that fired while it waited on the lock may be stale: a run
        # started (cancelling it) and ended (setting a newer one) meanwhile.
        if _idle is not timer or _users or _closed:
            return
        pool, _pool, _idle = _pool, None, None
    if pool is not None:
        pool.shutdown(wait=False)


def shutdown() -> None:
    """Stop the worker for good (the app's shutdown). A run still going
    finishes in its own thread."""
    global _pool, _closed, _idle
    with _lock:
        _closed = True
        pool, _pool = _pool, None
        if _idle is not None:
            _idle.cancel()
            _idle = None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)
