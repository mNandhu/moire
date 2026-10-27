"""The read routes' response models describe the wire without changing it.

The image models must name exactly the keys in the payload snapshot, and
the routes that skip response validation (the feed and the tag list return a
JSONResponse) must still send rows their models reproduce byte for byte."""

import json
from pathlib import Path

import pytest

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


def _same_json(model, row: dict) -> bool:
    """``row`` survives ``model`` unchanged: keys, order and value types (a
    dict compare would let 3 equal 3.0)."""
    dumped = model.model_validate(row).model_dump(mode="json", by_alias=True)
    return json.dumps(dumped) == json.dumps(row)


async def test_unvalidated_routes_send_rows_their_models_reproduce(client, seed):
    seed("L1:a.png", tags=("cat",), width=64, height=32, mtime=100.5, score=3)
    seed("L1:b.png", rating="general")
    feed = (await client.get("/images")).json()
    tags = (await client.get("/tags")).json()
    assert len(feed) == 2 and tags
    assert all(_same_json(FeedRow, row) for row in feed)
    assert all(_same_json(TagCount, row) for row in tags)


async def test_undeclared_keys_pass_through():
    # A column added on the service side reaches the client (and the payload
    # snapshot) instead of being dropped by the model.
    row = {"_id": "L1", "path": None, "name": None, "indexed_count": 0}
    row |= dict.fromkeys(
        ["last_scanned", "scanning", "scan_total", "scan_done", "scan_error"]
    )
    row |= dict.fromkeys(["scan_failed_count", "watch_enabled", "last_event_at"])
    row |= {"deleting": False, "new_column": 1}
    assert _same_json(LibraryRow, row)
