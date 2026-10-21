"""Integration tests for workflow families: naming one, importing saved
ComfyUI files, and matching each workflow version to its file."""

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t

pytestmark = pytest.mark.asyncio

WID = "c4852d87-9039-4215-95f6-880cdc42ee0d"
BASE = ["KSampler", "VAEDecode", "CLIPTextEncode", "CLIPTextEncode", "SaveImage"]


def _raw(image_id: str, sig: str, ui_types: list[str], wid: str = WID) -> None:
    prompt = {str(i): {"class_type": ty} for i, ty in enumerate(ui_types)}
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=sig,
                raw={
                    "source": "comfyui",
                    "prompt": prompt,
                    "workflow": {"id": wid, "nodes": [{"type": ty} for ty in ui_types]},
                },
            )
        )


async def _sigs(client) -> dict[str, dict]:
    resp = await client.get("/rules/signatures")
    assert resp.status_code == 200, resp.text
    return {r["workflow_sig"]: r for r in resp.json()}


async def test_family_name_and_file_match(client, seed):
    seed("L1:a.png", gen={"workflow_sig": "base", "prompt": "x"})
    seed("L1:b.png", gen={"workflow_sig": "face", "prompt": "x"})
    _raw("L1:a.png", "base", BASE)
    _raw("L1:b.png", "face", BASE + ["FaceDetailer"])

    sigs = await _sigs(client)
    assert sigs["base"]["workflow_id"] == WID
    assert sigs["face"]["node_types"]["FaceDetailer"] == 1
    assert "first_used" in sigs["face"] and "last_used" in sigs["face"]
    assert sigs["face"]["node_types"]["CLIPTextEncode"] == 2
    assert sigs["face"]["workflow_name"] is None
    assert sigs["face"]["file_name"] is None

    # Import two saved versions of the same file (same id, as ComfyUI keeps
    # it on Save As). Each image version matches the file it came from.
    resp = await client.post(
        "/rules/workflow-files",
        json=[
            {"workflow_id": WID, "filename": "RemoteQV2.1", "node_types": BASE},
            {
                "workflow_id": WID,
                "filename": "RemoteQV2.2",
                "node_types": BASE + ["FaceDetailer"],
            },
            {"workflow_id": "other", "filename": "Unused", "node_types": ["X"]},
        ],
    )
    assert resp.json() == {"imported": 3, "known": 1, "known_ids": [WID]}
    sigs = await _sigs(client)
    assert sigs["base"]["file_name"] == "RemoteQV2.1"
    assert sigs["face"]["file_name"] == "RemoteQV2.2"
    assert sigs["face"]["file_match"] == 1.0

    # Name the family; an empty name clears it again.
    resp = await client.put(f"/rules/workflows/{WID}/name", json={"name": " RemoteQ "})
    assert resp.json()["name"] == "RemoteQ"
    assert (await _sigs(client))["base"]["workflow_name"] == "RemoteQ"
    await client.put(f"/rules/workflows/{WID}/name", json={"name": ""})
    assert (await _sigs(client))["base"]["workflow_name"] is None


async def test_reimport_replaces_node_types(client, seed):
    seed("L1:a.png", gen={"workflow_sig": "base", "prompt": "x"})
    _raw("L1:a.png", "base", BASE)
    body = {"workflow_id": WID, "filename": "F", "node_types": ["Y"]}
    await client.post("/rules/workflow-files", json=[body])
    assert (await _sigs(client))["base"]["file_name"] is None
    await client.post("/rules/workflow-files", json=[{**body, "node_types": BASE}])
    assert (await _sigs(client))["base"]["file_name"] == "F"
