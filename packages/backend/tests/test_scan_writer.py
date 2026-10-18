"""Unit tests for the scan's batched writer: the accounting where scan bugs hide
(last partial batch never flushed, buffers cleared before commit, indexed drift).
A counting sink stands in for the real transaction; no DB, no threads."""

from src.services.scan_writer import ScanWriter


def _img(i):
    return {"_id": f"L1:{i}"}


def test_flushes_automatically_at_batch_size():
    commits = []
    w = ScanWriter(
        lambda imgs, raws: commits.append((len(imgs), len(raws))), batch_size=200
    )
    for i in range(200):
        w.add(_img(i))
    assert commits == [(200, 0)]  # one auto-flush
    assert w.pending == 0
    assert w.indexed == 200


def test_final_partial_batch_must_be_flushed_explicitly():
    # The regression the seam exists for: a sub-batch is NOT committed until
    # flush() is called; and once it is, it lands exactly once.
    commits = []
    w = ScanWriter(lambda imgs, raws: commits.append(len(imgs)), batch_size=200)
    for i in range(5):
        w.add(_img(i))
    assert commits == []  # nothing committed yet
    assert w.pending == 5
    w.flush()
    assert commits == [5]
    assert w.indexed == 5


def test_indexed_accumulates_across_auto_and_final_flush():
    commits = []
    w = ScanWriter(lambda imgs, raws: commits.append(len(imgs)), batch_size=200)
    for i in range(250):
        w.add(_img(i))
    w.flush()
    assert commits == [200, 50]  # auto-flush then remainder
    assert w.indexed == 250


def test_flush_is_idempotent_when_empty():
    commits = []
    w = ScanWriter(lambda imgs, raws: commits.append(1), batch_size=200)
    w.flush()
    w.flush()
    assert commits == []  # empty flush never calls the sink


def test_double_flush_does_not_recommit_same_rows():
    commits = []
    w = ScanWriter(lambda imgs, raws: commits.append(len(imgs)), batch_size=200)
    w.add(_img(1))
    w.flush()
    w.flush()  # buffers were cleared; second flush is a no-op
    assert commits == [1]
    assert w.indexed == 1


def test_gen_raw_rows_travel_with_their_batch():
    captured = []
    w = ScanWriter(lambda imgs, raws: captured.append((imgs, raws)), batch_size=200)
    w.add(_img(1), {"_id": "L1:1", "raw": {}})
    w.add(_img(2))  # no gen-raw
    w.flush()
    imgs, raws = captured[0]
    assert len(imgs) == 2 and len(raws) == 1
