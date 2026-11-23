"""N15: a library, by-signature or full reprojection skips raw rows whose
inputs (raw, ruleset, settings, DERIVE_VERSION) are unchanged since they were
last derived, before reading the raw."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.library import scanner
from moire.services.metadata import gen_metadata, reproject
from moire.services.tags import rules as tag_rules


def _raw_row(image_id, prompt, *, sig=None, lib="L1"):
    return {
        "_id": image_id,
        "library_id": lib,
        "workflow_sig": sig,
        "raw": {"source": "a1111", "parameters": f"{prompt}\nSteps: 20"},
    }


def _setup(seed, rows):
    for row in rows:
        seed(row["_id"], library_id=row["library_id"], tags=("manual:keep",))
    with db.sync_tx() as conn:
        scanner.write_gen_raws(conn, rows)


_ROWS = [
    _raw_row("L1:a", "cat"),
    _raw_row("L1:b", "dog", sig="s1"),
    _raw_row("L1:c", "bird", sig="s2"),
]


@pytest.fixture
def derived(monkeypatch):
    """The ids each derive call saw."""
    seen: list[str] = []
    real = gen_metadata.derive

    def counting(raw, ruleset, config):
        seen.append(raw["_id"])
        return real(raw, ruleset, config)

    monkeypatch.setattr(gen_metadata, "derive", counting)
    return seen


def _gen(image_id):
    with db.sync_conn() as conn:
        return conn.execute(
            sa.select(t.images.c.gen, t.images.c.tags).where(t.images.c._id == image_id)
        ).one()


def test_a_no_change_run_reads_no_raw(temp_db, seed, derived):
    _setup(seed, _ROWS)
    assert reproject.reproject_all() == 3
    derived.clear()

    assert reproject.reproject_all() == 0
    assert reproject.reproject_library("L1") == 0
    assert reproject.reproject_by_sig("s1") == 0
    assert derived == []


def test_force_bypasses_the_skip(temp_db, seed, derived):
    """Migrations run forced: every row is derived and rewritten."""
    _setup(seed, _ROWS)
    reproject.reproject_all()
    derived.clear()

    assert reproject.reproject_all(force=True) == 3
    assert sorted(derived) == ["L1:a", "L1:b", "L1:c"]


async def test_the_manual_library_run_is_forced(temp_db, seed, client, monkeypatch):
    """``POST /libraries/{id}/reproject`` is a repair: it rewrites current rows."""
    with db.sync_tx() as conn:
        conn.execute(sa.insert(t.libraries).values(_id="L1", path="/x"))
    started = []
    monkeypatch.setattr(
        reproject,
        "reproject_library_async",
        lambda lid, **kw: started.append((lid, kw)),
    )
    assert (await client.post("/libraries/L1/reproject")).status_code == 200
    assert started == [("L1", {"force": True})]


def test_id_targeted_runs_never_skip(temp_db, seed, derived):
    _setup(seed, _ROWS)
    reproject.reproject_all()
    derived.clear()

    assert reproject.reproject_ids(["L1:a", "L1:b"]) == 2
    assert reproject.reproject_image("L1:c") == 1
    assert sorted(derived) == ["L1:a", "L1:b", "L1:c"]


def test_a_raw_rewrite_is_derived_again(temp_db, seed, derived):
    _setup(seed, _ROWS)
    reproject.reproject_all()
    derived.clear()

    with db.sync_tx() as conn:  # a rescan of a changed file
        scanner.write_gen_raws(conn, [_raw_row("L1:a", "fox")])

    assert reproject.reproject_library("L1") == 1
    assert derived == ["L1:a"]
    gen, tags = _gen("L1:a")
    assert gen["prompt_terms"] == ["fox"]
    assert tags == ["manual:keep", "prompt:fox"]


def test_a_raw_rewritten_mid_run_is_not_stamped(temp_db, seed, monkeypatch):
    """The run reads the old raw, the scanner rewrites it, then the run
    flushes: its stamp must not land on the new raw, or no later run would
    derive it."""
    _setup(seed, [_raw_row("L1:a", "cat")])
    flush = reproject._flush_batch
    raced = []

    def rewrite_then_flush(batch, **kw):
        if not raced:
            raced.append(True)
            with db.sync_tx() as conn:
                scanner.write_gen_raws(conn, [_raw_row("L1:a", "fox")])
        return flush(batch, **kw)

    monkeypatch.setattr(reproject, "_flush_batch", rewrite_then_flush)
    assert reproject.reproject_all() == 1
    assert _gen("L1:a").gen["prompt_terms"] == ["cat"]  # what it read

    assert reproject.reproject_all() == 1
    assert _gen("L1:a").gen["prompt_terms"] == ["fox"]
    assert reproject.reproject_all() == 0


def test_a_raw_recreated_mid_run_is_not_stamped(temp_db, seed, monkeypatch):
    """The run reads the raw at its first revision; the raw is deleted (its
    stamp row cascades away) and written again before the flush. The new
    raw's revision must differ from the one read, or the run would stamp a
    raw it never read."""
    _setup(seed, [_raw_row("L1:a", "cat")])
    flush = reproject._flush_batch
    raced = []

    def recreate_then_flush(batch, **kw):
        if not raced:
            raced.append(True)
            with db.sync_tx() as conn:
                conn.execute(
                    sa.delete(t.image_gen_raw).where(t.image_gen_raw.c._id == "L1:a")
                )
            with db.sync_tx() as conn:
                scanner.write_gen_raws(conn, [_raw_row("L1:a", "fox")])
        return flush(batch, **kw)

    monkeypatch.setattr(reproject, "_flush_batch", recreate_then_flush)
    assert reproject.reproject_all() == 1
    assert _gen("L1:a").gen["prompt_terms"] == ["cat"]  # what it read

    assert reproject.reproject_all() == 1
    assert _gen("L1:a").gen["prompt_terms"] == ["fox"]


def test_a_ruleset_change_rederives_only_its_signature(temp_db, seed, derived):
    _setup(seed, _ROWS)
    reproject.reproject_all()
    derived.clear()

    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.gen_rulesets).values(
                sig="s1", doc={"fields": {"model": ["parameters"]}}
            )
        )

    assert reproject.reproject_all() == 1
    assert derived == ["L1:b"]
    assert reproject.reproject_all() == 0  # stamped with the new key


@pytest.mark.parametrize("change", ["rules", "version"])
def test_a_settings_or_version_change_rederives_everything(
    temp_db, seed, derived, monkeypatch, change
):
    _setup(seed, _ROWS)
    reproject.reproject_all()
    derived.clear()

    if change == "rules":
        real = tag_rules.load_rules_sync
        monkeypatch.setattr(
            tag_rules, "load_rules_sync", lambda conn: {**real(conn), "cat": ["kitten"]}
        )
    else:
        monkeypatch.setattr(
            gen_metadata, "DERIVE_VERSION", gen_metadata.DERIVE_VERSION + 1
        )

    assert reproject.reproject_all() == 3
    if change == "rules":
        assert _gen("L1:a").gen["prompt_terms"] == ["kitten"]
    assert reproject.reproject_all() == 0


def test_a_row_that_fails_to_derive_is_tried_again(temp_db, seed, monkeypatch):
    _setup(seed, _ROWS)
    real = gen_metadata.derive

    def hostile(raw, ruleset, config):
        if raw["_id"] == "L1:b":
            raise ValueError("bad graph")
        return real(raw, ruleset, config)

    monkeypatch.setattr(gen_metadata, "derive", hostile)
    assert reproject.reproject_all() == 2
    monkeypatch.setattr(gen_metadata, "derive", real)
    assert reproject.reproject_all() == 1


def test_the_progress_total_counts_only_stale_rows(temp_db, seed):
    class Task:
        total = 0
        done = 0

        def add_total(self, n):
            self.total += n

        def advance(self, n=1):
            self.done += n

    _setup(seed, _ROWS)
    reproject.reproject_all()
    with db.sync_tx() as conn:
        scanner.write_gen_raws(conn, [_raw_row("L1:c", "fox", sig="s2")])

    task = Task()
    reproject.reproject_all(task=task)
    assert (task.total, task.done) == (1, 1)


def test_underived_rows_still_resume(temp_db, seed):
    """`underived_ids` (gen null) feeds an id-targeted run, which derives
    them whatever their stamp says."""
    _setup(seed, _ROWS)
    reproject.reproject_all()
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images).where(t.images.c._id == "L1:a").values(gen=None)
        )

    assert reproject.underived_ids("L1") == ["L1:a"]
    assert reproject.reproject_ids(reproject.underived_ids("L1")) == 1
    assert reproject.underived_ids("L1") == []


def test_a_cut_off_run_leaves_the_rest_unstamped(temp_db, seed, monkeypatch):
    _setup(seed, _ROWS)
    monkeypatch.setattr(reproject, "_BATCH", 1)
    flush = reproject._flush_batch
    calls = []

    def dies(batch, **kw):
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("restart")
        return flush(batch, **kw)

    monkeypatch.setattr(reproject, "_flush_batch", dies)
    with pytest.raises(RuntimeError):
        reproject.reproject_all()
    monkeypatch.setattr(reproject, "_flush_batch", flush)

    assert reproject.reproject_all() == 2


def test_deleting_a_raw_drops_its_stamp(temp_db, seed):
    _setup(seed, _ROWS)
    reproject.reproject_all()
    with db.sync_tx() as conn:
        conn.execute(sa.delete(t.image_gen_raw).where(t.image_gen_raw.c._id == "L1:a"))
        stamps = conn.execute(sa.select(t.image_gen_derived.c._id)).scalars().all()
    assert sorted(stamps) == ["L1:b", "L1:c"]


def test_a_small_rescan_also_derives_rows_left_unstamped(temp_db, seed, monkeypatch):
    """Raws rewritten but never derived (a post-scan run cut off, a cancelled
    scan's committed batches) keep a cleared stamp; the next small rescan
    derives them along with the rows it wrote itself."""
    _setup(seed, [_raw_row(f"L1:{i}", "cat") for i in range(6)])
    reproject.reproject_all()
    with db.sync_tx() as conn:  # rewritten, never derived
        scanner.write_gen_raws(conn, [_raw_row("L1:1", "fox"), _raw_row("L1:2", "fox")])

    whole, some = [], []
    monkeypatch.setattr(reproject, "reproject_library_async", whole.append)
    monkeypatch.setattr(reproject, "reproject_ids_async", some.append)
    scanner._after_scan("L1", written_raw_ids={"L1:4"})
    assert whole == []
    assert some == [["L1:1", "L1:2", "L1:4"]]
