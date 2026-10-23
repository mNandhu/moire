"""Reprojection runs never overlap: a run that read older settings can't
write after a run started with newer ones, so the latest settings win."""

import threading

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import gen_metadata, reproject

pytestmark = pytest.mark.asyncio


def _tags(image_id: str) -> list[str]:
    with db.sync_conn() as conn:
        return conn.execute(
            sa.select(t.images.c.tags).where(t.images.c._id == image_id)
        ).scalar()


async def test_overlapping_runs_end_with_the_latest_rules(seed, monkeypatch):
    seed("L1:a")
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id="L1:a",
                library_id="L1",
                workflow_sig=None,
                raw={"source": "a1111", "parameters": "blue eyes\nSteps: 20"},
            )
        )

    # The first run stops mid-derive, after reading its settings.
    entered, release = threading.Event(), threading.Event()
    derive = gen_metadata.derive

    def gated(*args, **kw):
        if threading.current_thread().name == "first":
            entered.set()
            release.wait(5)
        return derive(*args, **kw)

    monkeypatch.setattr(gen_metadata, "derive", gated)
    first = threading.Thread(
        target=reproject.reproject_ids, args=(["L1:a"],), name="first"
    )
    first.start()
    assert entered.wait(5)

    # A merge rule lands while the first run holds the old rules, and its
    # own reprojection starts.
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.tag_rules).values(
                from_name="blue_eyes", to_names=["aqua_eyes"], created_at=1.0
            )
        )
    second = threading.Thread(
        target=reproject.reproject_ids, args=(["L1:a"],), name="second"
    )
    second.start()
    # Unserialized, the second run finishes here and the first then
    # overwrites it; serialized, it waits for the first.
    second.join(1)
    release.set()
    first.join(5)
    second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert _tags("L1:a") == ["prompt:aqua_eyes"]


async def test_spawned_runs_are_joinable_and_tracked(seed, monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(
        reproject,
        "reproject_ids",
        lambda ids, *, task: calls.append(("ids", ids, task.kind)),
    )
    monkeypatch.setattr(
        reproject,
        "reproject_library",
        lambda lid, *, workflow_sig, task: calls.append(
            ("lib", lid, workflow_sig, task.library_id)
        ),
    )
    reproject.reproject_ids_async(["x"]).join(5)
    reproject.reproject_library_async("L1", workflow_sig="s").join(5)
    assert calls == [("ids", ["x"], "reproject"), ("lib", "L1", "s", "L1")]
