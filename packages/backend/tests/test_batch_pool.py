"""Unit tests for the bounded-concurrency worker loop extracted from the scan
closure. A plain list + a fake worker + a cancel flag exercise prime/wait/refill
/cancel without a filesystem or DB."""

from src.services.batch_pool import run_pool


def test_processes_every_item_and_reports_no_errors():
    results = []
    ok = run_pool(
        range(50),
        lambda x: x * 2,
        lambda r, e: results.append((r, e)),
        max_workers=4,
    )
    assert ok is True
    assert sorted(r for r, e in results) == [x * 2 for x in range(50)]
    assert all(e is None for r, e in results)


def test_work_exception_surfaces_as_exc_not_swallowed():
    def work(x):
        if x == 2:
            raise ValueError("boom")
        return x

    seen = []
    ok = run_pool([1, 2, 3], work, lambda r, e: seen.append((r, e)), max_workers=1)
    assert ok is True
    errs = [e for r, e in seen if e is not None]
    assert len(errs) == 1 and isinstance(errs[0], ValueError)


def test_cancel_returns_false_and_skips_remaining():
    # is_cancelled is False for the first prime-submit, True thereafter, so a
    # future gets submitted, then the loop notices the cancel and stops.
    calls = {"n": 0}

    def is_cancelled():
        calls["n"] += 1
        return calls["n"] > 1

    results = []
    ok = run_pool(
        [1, 2, 3, 4],
        lambda x: x,
        lambda r, e: results.append(r),
        max_workers=2,
        max_pending=2,
        is_cancelled=is_cancelled,
    )
    assert ok is False
    assert len(results) < 4  # did not process every item
