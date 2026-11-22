"""Reprojection over many rows: raws read in pages, tag views soft-dirtied
per batch and hard-invalidated once when the run ends."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.metadata import reproject

# Inserted out of _id order, across two libraries.
_IDS = [
    ("L1:e", "L1"),
    ("L2:a", "L2"),
    ("L1:a", "L1"),
    ("L1:c", "L1"),
    ("L2:b", "L2"),
    ("L1:b", "L1"),
    ("L1:d", "L1"),
]


def _raws(seed):
    for image_id, lib in _IDS:
        seed(image_id, library_id=lib, tags=())
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw),
            [
                {
                    "_id": image_id,
                    "library_id": lib,
                    "workflow_sig": None,
                    "raw": {"source": "a1111", "parameters": f"tag_{i}\nSteps: 20"},
                }
                for i, (image_id, lib) in enumerate(_IDS)
            ],
        )


def _tags() -> dict[str, list[str]]:
    with db.sync_conn() as conn:
        return {
            r._id: list(r.tags or [])
            for r in conn.execute(sa.select(t.images.c._id, t.images.c.tags))
        }


class _Task:
    def __init__(self):
        self.total = 0
        self.done = 0

    def add_total(self, n):
        self.total += n

    def advance(self, n=1):
        self.done += n


# --- N4: paging ----------------------------------------------------------------


@pytest.mark.parametrize("page", [1, 2, 3, 7, 1000])
def test_raw_pages_yield_every_match_once(temp_db, seed, monkeypatch, page):
    _raws(seed)
    monkeypatch.setattr(reproject, "_PAGE", page)

    every = [r._id for r in reproject._raw_pages(sa.true())]
    lib1 = [r._id for r in reproject._raw_pages(t.image_gen_raw.c.library_id == "L1")]

    assert sorted(every) == sorted(i for i, _ in _IDS)
    assert len(every) == len(set(every))
    assert sorted(lib1) == ["L1:a", "L1:b", "L1:c", "L1:d", "L1:e"]


@pytest.mark.parametrize("page", [2, 3])
def test_a_paged_run_derives_what_one_read_does(temp_db, seed, monkeypatch, page):
    _raws(seed)
    monkeypatch.setattr(reproject, "_BATCH", 2)
    monkeypatch.setattr(reproject, "_PAGE", 1000)
    task = _Task()
    assert reproject.reproject_library("L1", task=task) == 5
    assert (task.total, task.done) == (5, 5)
    one_read = _tags()

    monkeypatch.setattr(reproject, "_PAGE", page)
    task = _Task()
    assert reproject.reproject_all(force=True, task=task) == 7
    assert (task.total, task.done) == (7, 7)
    paged = _tags()

    assert {k: v for k, v in paged.items() if k.startswith("L1:")} == {
        k: v for k, v in one_read.items() if k.startswith("L1:")
    }
    assert paged["L1:c"] == ["prompt:tag_3"]
    assert paged["L2:b"] == ["prompt:tag_4"]


def test_a_paged_ids_run_derives_every_id(temp_db, seed, monkeypatch):
    _raws(seed)
    monkeypatch.setattr(reproject, "_PAGE", 2)
    task = _Task()
    assert reproject.reproject_ids(["L1:a", "L2:b", "L1:d"], task=task) == 3
    assert (task.total, task.done) == (3, 3)
    tags = _tags()
    assert [tags[i] for i in ("L1:a", "L2:b", "L1:d", "L1:b")] == [
        ["prompt:tag_2"],
        ["prompt:tag_4"],
        ["prompt:tag_6"],
        [],
    ]


# --- N6: soft per batch, one hard at the end --------------------------------------


@pytest.fixture
def calls(monkeypatch):
    from moire.services.tags import index as tag_index

    seen: list[str] = []
    monkeypatch.setattr(tag_index, "invalidate", lambda: seen.append("hard"))
    monkeypatch.setattr(tag_index, "invalidate_soft", lambda: seen.append("soft"))
    return seen


def test_a_run_dirties_softly_per_batch_and_hard_once(
    temp_db, seed, monkeypatch, calls
):
    _raws(seed)
    monkeypatch.setattr(reproject, "_BATCH", 2)

    assert reproject.reproject_all() == 7

    # 7 rows in batches of 2: four batches, then the run's one hard.
    assert calls == ["soft"] * 4 + ["hard"]


def test_an_ids_run_invalidates_once_across_its_chunks(
    temp_db, seed, monkeypatch, calls
):
    _raws(seed)
    monkeypatch.setattr(reproject, "_BATCH", 1)
    monkeypatch.setattr(reproject, "_ID_CHUNK", 2)

    assert reproject.reproject_ids([i for i, _ in _IDS]) == 7

    assert calls == ["soft"] * 7 + ["hard"]


def test_a_failing_run_still_invalidates_once(temp_db, seed, monkeypatch, calls):
    _raws(seed)
    monkeypatch.setattr(reproject, "_BATCH", 2)
    flush = reproject._flush_batch
    flushed = []

    def failing(batch, **kw):
        if flushed:
            raise RuntimeError("disk full")
        flushed.append(batch)
        return flush(batch, **kw)

    monkeypatch.setattr(reproject, "_flush_batch", failing)

    with pytest.raises(RuntimeError):
        reproject.reproject_all()

    assert calls == ["soft", "hard"]


def test_a_run_that_writes_nothing_does_not_invalidate(
    temp_db, seed, monkeypatch, calls
):
    _raws(seed)
    reproject.reproject_all()
    calls.clear()

    assert reproject.reproject_all() == 7  # derived, all already up to date
    assert reproject.reproject_image("L1:a") == 1

    assert calls == []
