"""The scan's batched transactional writer.

A ``ScanWriter`` accumulates indexed image rows (and their optional raw-gen rows)
and commits them in batches of ``batch_size`` through a caller-supplied ``commit``
sink, then flushes the remainder at the end. Pulling this out of the scan closure
gives the batch accounting a direct test surface, the exact place scan bugs hide:
the last partial batch never flushed, buffers cleared before a failed commit, the
``indexed`` count drifting from what was actually written.

The ``commit`` sink owns the I/O (transaction + retry); ``ScanWriter`` owns only
the accumulate / flush-every-N / flush-remainder accounting, so it can be tested
with a list of fake rows and a counting sink; no DB, no threads.
"""

from __future__ import annotations

from typing import Callable

# A commit sink is handed the image rows and the raw-gen rows for one batch and is
# responsible for persisting them together (and atomically, in production).
CommitSink = Callable[[list[dict], list[dict]], None]


class ScanWriter:
    def __init__(self, commit: CommitSink, *, batch_size: int = 200) -> None:
        self._commit = commit
        self._batch_size = max(1, batch_size)
        self._image_rows: list[dict] = []
        self._gen_raw_rows: list[dict] = []
        # Count of image rows actually handed to the commit sink.
        self.indexed = 0

    @property
    def pending(self) -> int:
        """Image rows buffered but not yet flushed."""
        return len(self._image_rows)

    def add(self, image_row: dict, gen_raw_row: dict | None = None) -> None:
        """Buffer one indexed image (and its raw-gen row, if any). Flushes
        automatically once the image buffer reaches ``batch_size``."""
        self._image_rows.append(image_row)
        if gen_raw_row is not None:
            self._gen_raw_rows.append(gen_raw_row)
        if len(self._image_rows) >= self._batch_size:
            self.flush()

    def flush(self) -> None:
        """Commit whatever is buffered (no-op if empty). Snapshots and clears the
        buffers before calling the sink so a re-entrant/repeat call can't double
        the same rows."""
        if not self._image_rows and not self._gen_raw_rows:
            return
        imgs = list(self._image_rows)
        raws = list(self._gen_raw_rows)
        self._image_rows.clear()
        self._gen_raw_rows.clear()
        self._commit(imgs, raws)
        self.indexed += len(imgs)
