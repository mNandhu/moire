"""Bounded-concurrency worker loop, lifted out of the scan closure.

``run_pool`` runs ``work`` over ``items`` with at most ``max_workers`` threads and
at most ``max_pending`` futures in flight at once (so a huge library doesn't
balloon memory by submitting everything up front). It calls ``on_complete`` once
per finished item, in completion order, with either the result or the exception
that ``work`` raised. Between waves it consults ``is_cancelled``; on cancel it
cancels the not-yet-started futures and stops, returning ``False``.

This is the part of scanning that is fiddly to get right (prime / wait / refill /
cancel) but trivial to test: hand it a list, a fake ``work``, and a cancel flag.
The domain decisions (what a result means, when to flush) stay with the caller
via ``on_complete``.
"""

from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Callable, Iterable, TypeVar

T = TypeVar("T")
R = TypeVar("R")


def run_pool(
    items: Iterable[T],
    work: Callable[[T], R],
    on_complete: Callable[[R | None, BaseException | None], None],
    *,
    max_workers: int,
    max_pending: int | None = None,
    is_cancelled: Callable[[], bool] = lambda: False,
) -> bool:
    """Process ``items`` with bounded concurrency. Returns ``True`` if every item
    finished, ``False`` if the run was cancelled partway."""
    if max_pending is None:
        max_pending = max(1, max_workers * 2)

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        it = iter(items)
        pending: set = set()

        def _refill() -> None:
            while len(pending) < max_pending:
                if is_cancelled():
                    return
                try:
                    item = next(it)
                except StopIteration:
                    return
                pending.add(ex.submit(work, item))

        _refill()
        while pending:
            if is_cancelled():
                # Cancel futures that haven't started yet; the running ones are
                # left to finish and are simply not awaited.
                for fut in list(pending):
                    fut.cancel()
                pending.clear()
                return False

            done_set, pending = wait(pending, return_when=FIRST_COMPLETED)
            for fut in done_set:
                try:
                    res: R | None = fut.result()
                    exc: BaseException | None = None
                except Exception as e:  # noqa: BLE001 (reported, not swallowed)
                    res, exc = None, e
                on_complete(res, exc)
            _refill()

    return True
