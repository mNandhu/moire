"""Loras end to end: extracted from the graph by reprojection, stored as
derived rows, filterable in the feed and counted for the dropdown."""

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import reproject


def _comfy(image_id, loras):
    graph = {
        str(i): {
            "class_type": "LoraLoader",
            "inputs": {"lora_name": f"{n}.safetensors", "strength_model": 0.5},
        }
        for i, n in enumerate(loras)
    }
    graph["99"] = {"class_type": "KSampler", "inputs": {"seed": 1}}
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=None,
                raw={"source": "comfyui", "prompt": graph},
            )
        )


async def test_loras_are_extracted_filterable_and_counted(client, seed):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    seed("L1:c", tags=())
    _comfy("L1:a", ["style", "eyes"])
    _comfy("L1:b", ["style"])
    _comfy("L1:c", [])
    reproject.reproject_library("L1")

    doc = (await client.get("/images/L1:a")).json()
    assert doc["gen"]["loras"] == [
        {"name": "style", "strength": 0.5},
        {"name": "eyes", "strength": 0.5},
    ]

    ids = lambda r: sorted(it["_id"] for it in r.json())  # noqa: E731
    assert ids(await client.get("/images", params={"lora": "style"})) == [
        "L1:a",
        "L1:b",
    ]
    assert ids(
        await client.get("/images", params=[("lora", "style"), ("lora", "eyes")])
    ) == ["L1:a"]

    counts = (await client.get("/images/loras")).json()
    assert counts == [{"name": "style", "count": 2}, {"name": "eyes", "count": 1}]


async def test_reprojection_replaces_lora_rows(client, seed):
    seed("L1:a", tags=())
    _comfy("L1:a", ["old"])
    reproject.reproject_library("L1")
    with db.sync_tx() as conn:
        conn.execute(sa.delete(t.image_gen_raw))
    _comfy("L1:a", ["new"])
    reproject.reproject_library("L1")
    assert (await client.get("/images/loras")).json() == [{"name": "new", "count": 1}]
