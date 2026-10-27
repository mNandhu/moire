"""The read routes' response models describe the wire without changing it.

The models are documentation only (``responses.documents``), so nothing at
runtime holds them to the payloads. These tests do: the image models must name
exactly the keys in the payload snapshot, and every row each documented route
returns must validate against its model in strict mode (no int read as bool,
no str read as int) and dump back to the same JSON."""

import json
from pathlib import Path

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.models.responses import (
    FeedRow,
    GroupRow,
    ImageDetail,
    LibraryRow,
    TagCount,
)

pytestmark = pytest.mark.asyncio

SNAPSHOT = json.loads(
    (Path(__file__).parent / "fixtures" / "mirrored" / "image_payloads.json").read_text(
        encoding="utf-8"
    )
)


def _keys(model) -> list[str]:
    return sorted(f.alias or name for name, f in model.model_fields.items())


@pytest.mark.parametrize(
    "model,payload",
    [(FeedRow, "feed"), (GroupRow, "group"), (ImageDetail, "detail")],
)
async def test_image_models_name_the_snapshot_keys(model, payload):
    assert _keys(model) == SNAPSHOT[payload]


def _assert_describes(model, rows: list[dict]) -> None:
    assert rows
    for row in rows:
        dumped = model.model_validate(row, strict=True).model_dump(
            mode="json", by_alias=True
        )
        # Sorted dumps, not a dict compare, so 3 against 3.0 still differs.
        assert json.dumps(dumped, sort_keys=True) == json.dumps(row, sort_keys=True)


async def test_models_describe_every_documented_route(client, seed, tmp_path):
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries).values(_id="L1", path=str(tmp_path), name="L1")
        )
    seed(
        "L1:a.png",
        tags=("cat", "manual:soft", "prompt:cat"),
        gen={"group_id": "g1", "prompt_terms": ["cat"], "steps": 20},
        width=64,
        height=32,
        mtime=100.5,
        score=3,
    )
    seed("L1:b.png", gen={"group_id": "g1"}, rating="general", mtime=50)
    seed("L1:c.png", quarantined=True, thumb_key="L1/c.webp")
    seed("L1:d.png", width=10, height=10)

    async def get(path):
        resp = await client.get(path)
        assert resp.status_code == 200, resp.text
        return resp.json()

    _assert_describes(FeedRow, await get("/images"))
    _assert_describes(FeedRow, await get("/images?quarantined=1"))
    groups = await get("/images/groups")
    assert {row["group_id"] for row in groups} == {"g1", None}
    _assert_describes(GroupRow, groups)
    for image_id in ("L1:a.png", "L1:b.png", "L1:c.png", "L1:d.png"):
        _assert_describes(ImageDetail, [await get(f"/images/{image_id}")])
    for query in ("", "?include_manual=1&include_prompt=1", "?merge_sources=1"):
        _assert_describes(TagCount, await get(f"/tags{query}"))
    _assert_describes(LibraryRow, await get("/libraries"))


async def test_undeclared_keys_pass_through():
    # A column added on the service side still validates; the payload key
    # snapshot is what flags it.
    row = {"_id": "L1", "path": None, "name": None, "indexed_count": 0}
    row |= dict.fromkeys(
        ["last_scanned", "scanning", "scan_total", "scan_done", "scan_error"]
    )
    row |= dict.fromkeys(["scan_failed_count", "watch_enabled", "last_event_at"])
    row |= {"deleting": False, "new_column": 1}
    _assert_describes(LibraryRow, [row])
