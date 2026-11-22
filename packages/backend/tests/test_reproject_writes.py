"""N31: reprojection writes in short transactions, planned outside them, and
touches only the derived rows that changed."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.library import scanner
from moire.services.metadata import reproject
from moire.services.tags import image_tags
from moire.services.tags import index as tag_index
from moire.services.tags import rules as tag_rules


def _setup(seed, n=7):
    rows = [
        {
            "_id": f"L1:{i}",
            "library_id": "L1",
            "workflow_sig": None,
            "raw": {
                "source": "a1111",
                "parameters": f"cat, (dog:1.2), bird, tag_{i}, <lora:style:0.5>\nSteps: 20",
            },
        }
        for i in range(n)
    ]
    for row in rows:
        seed(row["_id"], tags=("manual:keep", "tree"))
    with db.sync_tx() as conn:
        scanner.write_gen_raws(conn, rows)
    return [r["_id"] for r in rows]


def _state() -> dict:
    """Every image's tags and derived rows, as sets."""
    with db.sync_conn() as conn:

        def rows(table, *cols):
            return set(conn.execute(sa.select(*(table.c[c] for c in cols))).all())

        return {
            "tags": {
                r._id: tuple(r.tags or [])
                for r in conn.execute(sa.select(t.images.c._id, t.images.c.tags))
            },
            "image_tags": rows(t.image_tags, "image_id", "tag", "base"),
            "terms": rows(t.image_gen_terms, "image_id", "term", "weight"),
            "loras": rows(t.image_loras, "image_id", "name", "strength"),
        }


def _consistent(state) -> None:
    """The join rows are exactly what the tag arrays imply."""
    implied = {
        (i, tag, image_tags.base_of(tag))
        for i, tags in state["tags"].items()
        for tag in tags
    }
    assert state["image_tags"] == implied


def test_a_settings_change_writes_what_a_full_rebuild_would(temp_db, seed, monkeypatch):
    _setup(seed)
    reproject.reproject_all()
    monkeypatch.setattr(
        tag_rules, "load_rules_sync", lambda conn: {"cat": ["kitten"], "dog": ["puppy"]}
    )

    assert reproject.reproject_all() == 7  # diffs only
    diffed = _state()
    _consistent(diffed)
    assert ("L1:0", "prompt:kitten", "kitten") in diffed["image_tags"]
    assert ("L1:0", "prompt:cat", "cat") not in diffed["image_tags"]
    assert ("L1:0", "puppy", 1.2) in diffed["terms"]

    reproject.reproject_all(force=True)  # everything rebuilt
    assert _state() == diffed


@pytest.mark.parametrize("table", ["image_tags", "image_gen_terms"])
def test_a_stray_join_row_does_not_wedge_the_diff(temp_db, seed, monkeypatch, table):
    """The diff is worked out from the stored JSON; a derived row the JSON
    lacks (drift) must not fail the insert, or every run would roll back on
    it."""
    _setup(seed, n=2)
    reproject.reproject_all()
    with db.sync_tx() as conn:
        if table == "image_tags":
            conn.execute(
                sa.insert(t.image_tags).values(
                    image_id="L1:0", tag="prompt:kitten", base="kitten"
                )
            )
        else:
            conn.execute(
                sa.insert(t.image_gen_terms).values(
                    image_id="L1:0", term="kitten", weight=0.5
                )
            )
    monkeypatch.setattr(tag_rules, "load_rules_sync", lambda conn: {"cat": ["kitten"]})

    assert reproject.reproject_all() == 2
    state = _state()
    _consistent(state)
    assert "prompt:kitten" in state["tags"]["L1:0"]
    assert ("L1:0", "kitten", 1.0) in state["terms"]
    assert ("L1:0", "kitten", 0.5) not in state["terms"]


@pytest.mark.parametrize("write", [2, 3, 50])
def test_each_commit_is_short_and_soft_invalidates(temp_db, seed, monkeypatch, write):
    _setup(seed)
    monkeypatch.setattr(reproject, "_WRITE", write)
    txs, softs = [], []
    real_tx = reproject.sync_tx

    def counting_tx():
        txs.append(1)
        return real_tx()

    monkeypatch.setattr(reproject, "sync_tx", counting_tx)
    monkeypatch.setattr(tag_index, "invalidate_soft", lambda: softs.append(1))

    assert reproject.reproject_all() == 7
    commits = -(-7 // write)
    assert len(txs) == commits
    assert len(softs) == commits


def test_a_tag_write_between_plan_and_commit_is_kept(temp_db, seed, monkeypatch):
    """Planning happens outside the write transaction; a tag write landing
    after it must survive, the transaction re-planning against it."""
    ids = _setup(seed, n=2)
    real_plan = reproject._plan
    raced = []

    def plan_then_tag(image_id, g, row, *, force):
        planned = real_plan(image_id, g, row, force=force)
        if image_id == ids[0] and not raced:
            raced.append(True)
            with db.sync_tx() as conn:  # as if the AI job tagged it now
                image_tags.rewrite_tags_sync(conn, image_id, [*(row.tags or []), "fox"])
        return planned

    monkeypatch.setattr(reproject, "_plan", plan_then_tag)
    reproject.reproject_all()

    state = _state()
    _consistent(state)
    assert "fox" in state["tags"][ids[0]]
    assert "prompt:cat" in state["tags"][ids[0]]
    assert "manual:keep" in state["tags"][ids[0]]


def test_a_tag_write_before_a_stamp_only_row_is_stamped_is_rechecked(
    temp_db, seed, monkeypatch
):
    """A row planned as nothing-to-write is stamped in a later transaction;
    a tag write that dropped its prompt tags meanwhile must be repaired
    there, not stamped over (no later non-forced run would read it)."""
    ids = _setup(seed, n=2)
    reproject.reproject_all()
    real_plan = reproject._plan
    raced = []

    def plan_then_untag(image_id, g, row, *, force):
        planned = real_plan(image_id, g, row, force=force)
        if image_id == ids[0] and not raced:
            raced.append(True)
            with db.sync_tx() as conn:
                image_tags.rewrite_tags_sync(conn, image_id, ["manual:keep", "tree"])
        return planned

    monkeypatch.setattr(reproject, "_plan", plan_then_untag)
    # A rule matching no term: every row is stale, none has anything to write.
    monkeypatch.setattr(tag_rules, "load_rules_sync", lambda conn: {"zebra": ["x"]})
    reproject.reproject_all()

    state = _state()
    _consistent(state)
    assert "prompt:cat" in state["tags"][ids[0]]
    assert "manual:keep" in state["tags"][ids[0]]


def test_rows_with_nothing_to_write_only_stamp(temp_db, seed, monkeypatch):
    _setup(seed)
    reproject.reproject_all()
    writes = []
    real = reproject._write_chunk
    monkeypatch.setattr(
        reproject,
        "_write_chunk",
        lambda conn, chunk, **kw: writes.append(len(chunk)) or real(conn, chunk, **kw),
    )
    # A rule matching no term: every row is stale and derived, none changes.
    monkeypatch.setattr(tag_rules, "load_rules_sync", lambda conn: {"zebra": ["x"]})

    assert reproject.reproject_all() == 7
    assert writes == []
    assert reproject.reproject_all() == 0  # all stamped
