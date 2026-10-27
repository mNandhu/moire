"""The three image payloads' key sets, pinned in a snapshot both sides read.

The feed row, the grouped (batch-collapsed) row and the single-image detail are
three shapes. ``fixtures/mirrored/image_payloads.json`` records each one's keys
as the routes return them; imageFilter.test.ts checks the frontend types'
field lists against the same file, so a key added or dropped here fails there
until the type follows. After a deliberate change, rerun with
``MOIRE_UPDATE_SNAPSHOTS=1`` to rewrite the file, then update the TS types."""

import json
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio

SNAPSHOT = Path(__file__).parent / "fixtures" / "mirrored" / "image_payloads.json"


async def _payload_keys(client, seed) -> dict[str, list[str]]:
    seed(
        "L1:a.png",
        tags=("cat", "prompt:cat"),
        gen={"group_id": "g1", "prompt_terms": ["cat"]},
        width=64,
        height=32,
        mtime=100,
    )
    seed("L1:b.png", gen={"group_id": "g1"}, mtime=50)
    seed("L1:c.png", mtime=10)

    async def get(path):
        resp = await client.get(path)
        assert resp.status_code == 200, resp.text
        return resp.json()

    def keys(rows: list[dict]) -> list[str]:
        # Every row's keys, so a key sent only on some rows (an ungrouped
        # tile, a NULL column) still reaches the snapshot.
        assert rows
        return sorted(set().union(*rows))

    groups = await get("/images/groups")
    assert {row["group_id"] for row in groups} == {"g1", None}
    details = [await get(f"/images/L1:{name}.png") for name in "abc"]
    return {
        "feed": keys(await get("/images")),
        "group": keys(groups),
        "detail": keys(details),
    }


async def test_image_payload_keys_match_snapshot(client, seed):
    got = await _payload_keys(client, seed)
    if os.environ.get("MOIRE_UPDATE_SNAPSHOTS"):
        SNAPSHOT.write_text(json.dumps(got, indent=2) + "\n", encoding="utf-8")
    want = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert got == want, (
        "image payload keys changed: rerun with MOIRE_UPDATE_SNAPSHOTS=1 and "
        "update the types in frontend src/lib/imageFilter.ts"
    )
