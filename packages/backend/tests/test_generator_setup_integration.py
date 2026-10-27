"""Custom Generator setup end to end: discover from a library image or an
uploaded file, save, the test-run gate, queueing with the Generator's own
batch size, slot edits resetting the gate."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import generator_setup
from tests.test_generate_integration import comfy, scanned, tick  # noqa: F401

FIXTURES = Path(__file__).parent / "fixtures"


def _graph(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _with_raw(seed, image_id: str, graph: dict, family: str | None = "fam-1"):
    seed(image_id, gen={"workflow_sig": "sig-1"})
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig="sig-1",
                raw={"prompt": graph, "workflow": {"id": family, "nodes": []}},
            )
        )
        if family:
            conn.execute(
                sa.insert(t.workflow_names).values(workflow_id=family, name="Portrait")
            )


async def _create(client, seed, graph=None, **slots_over):
    graph = graph or _graph("graph_hires_detailer.json")
    _with_raw(seed, "L1:a.png", graph)
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    r = await client.post(
        "/generate/generators",
        json={
            "source": {"image_id": "L1:a.png"},
            "name": d["source"]["family_name"],
            "slots": {**d["slots"], **slots_over},
            "defaults": d["defaults"],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


async def test_discover_from_a_library_image(client, seed):
    _with_raw(seed, "L1:a.png", _graph("graph_hires_detailer.json"))
    r = await client.post(
        "/generate/generators/discover", json={"image_id": "L1:a.png"}
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["source"] == {
        "kind": "image",
        "image_id": "L1:a.png",
        "family": "fam-1",
        "family_name": "Portrait",
        "file_name": None,
        "workflow_sig": "sig-1",
    }
    assert d["slots"]["positive"] == ["14", "text"]
    assert d["defaults"]["base"].startswith("text 2 of 14.text")


async def test_ruleset_pin_fills_a_runtime_prompt(client, seed):
    _with_raw(seed, "L1:a.png", _graph("graph_runtime_prompt.json"))
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.gen_rulesets).values(
                sig="sig-1", doc={"fields": {"prompt": ["prompt.50.inputs.text"]}}
            )
        )
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    assert d["slots"]["positive"] == ["50", "text"]
    assert d["found"]["positive"]["from"] == "rule"


async def test_upload_refuses_editor_files_and_no_graph(client):
    r = await client.post(
        "/generate/generators/discover",
        json={"graph": {"nodes": [], "links": [], "version": 0.4}},
    )
    assert r.status_code == 400 and "Export (API)" in r.json()["detail"]
    r = await client.post(
        "/generate/generators/discover", json={"graph": {"1": {"inputs": {}}}}
    )
    assert r.status_code == 400
    r = await client.post("/generate/generators/discover", json={"image_id": "nope"})
    assert r.status_code == 400


async def test_upload_discovers(client):
    r = await client.post(
        "/generate/generators/discover",
        json={
            "graph": _graph("graph_hires_detailer.json"),
            "filename": "a/b/flow.json",
        },
    )
    assert r.json()["source"] == {"kind": "upload", "filename": "flow.json"}


async def test_save_refuses_missing_prompt(client, seed):
    _with_raw(seed, "L1:a.png", _graph("graph_runtime_prompt.json"))
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    r = await client.post(
        "/generate/generators",
        json={"source": {"image_id": "L1:a.png"}, "name": "X", "slots": d["slots"]},
    )
    assert r.status_code == 400 and "positive" in r.json()["detail"]


async def test_custom_generator_gate_and_queue(client, comfy, seed):  # noqa: F811
    gen = await _create(client, seed)
    assert gen["kind"] == "custom" and gen["ready"] is False
    assert gen["defaults"]["base"].startswith("text 2 of 14.text")
    ids = [g["_id"] for g in (await client.get("/generate/generators")).json()]
    assert ids == ["builtin", gen["_id"]]

    r = await client.post(f"/generate/generators/{gen['_id']}/test", json={})
    assert r.status_code == 200, r.text
    pid = comfy.order[-1]
    sent = comfy.prompts[pid]
    # Its own prompt, a strength-0 LoRA after its own four, one image.
    assert sent["14"]["inputs"]["text"].startswith("text 2 of 14.text")
    assert sent["25"]["inputs"]["batch_size"] == 1
    added = [
        k
        for k, n in sent.items()
        if n["class_type"] == "LoraLoader"
        and k not in _graph("graph_hires_detailer.json")
    ]
    assert len(added) == 1 and sent[added[0]]["inputs"]["model"] == ["40", 0]
    assert sent["22"]["inputs"]["model"] == [added[0], 0]
    test_batch = r.json()["batch_id"]
    test = (await client.get(f"/generate/generators/{gen['_id']}")).json()["test"]
    assert test["batch_id"] == test_batch and test["image_id"] is None
    assert test["outputs"] == 0 and test["error"] is None
    await asyncio.to_thread(scanned, seed, comfy.finish(pid, images=1))
    await tick()
    view = (await client.get(f"/generate/generators/{gen['_id']}")).json()
    assert view["ready"]
    assert view["test"]["state"] == "done" and view["test"]["outputs"] == 1
    assert view["test"]["image_id"]

    # Count is images: the graph's batch size of 4 splits 6 into 4 + 2.
    r = await client.post(
        "/generate/batches",
        json={"generator_id": gen["_id"], "base": "1girl, beach", "count": 6},
    )
    assert r.status_code == 200, r.text
    assert [q["images"] for q in r.json()["requests"]] == [4, 2]
    sent = comfy.prompts[comfy.order[-1]]
    assert sent["14"]["inputs"]["text"] == "1girl, beach"
    # Every ticked seed gets the request's seed.
    seeds = {sent[n]["inputs"]["seed"] for n in ("16", "26", "34")}
    assert seeds == {r.json()["requests"][0]["seed"]}
    # A batch size asked for this batch applies to a custom Generator too.
    r = await client.post(
        "/generate/batches",
        json={"generator_id": gen["_id"], "base": "x", "count": 3, "per_request": 1},
    )
    assert [q["images"] for q in r.json()["requests"]] == [1, 1, 1]


async def test_no_insertion_point_means_no_test_lora(client, comfy, seed):  # noqa: F811
    gen = await _create(client, seed, lora_model=None, lora_clip=None)
    assert "lora_model" not in gen["slots"]
    await client.post(f"/generate/generators/{gen['_id']}/test", json={})
    sent = comfy.prompts[comfy.order[-1]]
    assert sum(n["class_type"] == "LoraLoader" for n in sent.values()) == 4


async def test_lora_text_puts_the_batch_loras_in_the_prompt(client, comfy, seed):  # noqa: F811
    # Only where there's no insertion point to splice into.
    with pytest.raises(generator_setup.SetupError):
        generator_setup.clean_slots({"lora_model": ["4", 0], "lora_text": True})
    gen = await _create(client, seed, lora_model=None, lora_clip=None, lora_text=True)
    assert gen["slots"]["lora_text"] is True
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.generators)
            .where(t.generators.c._id == gen["_id"])
            .values(ready=True)
        )
    r = await client.post(
        "/generate/batches",
        json={
            "generator_id": gen["_id"],
            "base": "1girl, solo",
            "loras": [{"name": "fern.safetensors", "strength": 0.7}],
        },
    )
    assert r.status_code == 200, r.text
    sent = comfy.prompts[comfy.order[-1]]
    path = gen["slots"]["positive"]
    assert sent[path[0]]["inputs"][path[1]].endswith("<lora:fern.safetensors:0.7>")
    assert sum(n["class_type"] == "LoraLoader" for n in sent.values()) == 4


async def test_slot_edit_resets_the_gate_rename_does_not(client, comfy, seed):  # noqa: F811
    gen = await _create(client, seed)
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.generators)
            .where(t.generators.c._id == gen["_id"])
            .values(ready=True)
        )
    r = await client.put(f"/generate/generators/{gen['_id']}", json={"name": "Hires"})
    assert r.json()["name"] == "Hires" and r.json()["ready"] is True
    setup = (await client.get(f"/generate/generators/{gen['_id']}/setup")).json()
    slots = {**setup["slots"], "seeds": [["16", "seed"]]}
    r = await client.put(f"/generate/generators/{gen['_id']}", json={"slots": slots})
    assert r.status_code == 200 and r.json()["ready"] is False
    bad = {**slots, "positive": ["99", "text"]}
    r = await client.put(f"/generate/generators/{gen['_id']}", json={"slots": bad})
    assert r.status_code == 400


async def test_builtin_cannot_be_edited_custom_can_be_deleted(client, comfy, seed):  # noqa: F811
    assert (
        await client.put("/generate/generators/builtin", json={"name": "x"})
    ).status_code == 400
    assert (await client.delete("/generate/generators/builtin")).status_code == 400
    gen = await _create(client, seed)
    assert (
        await client.delete(f"/generate/generators/{gen['_id']}")
    ).status_code == 200
    assert [g["_id"] for g in (await client.get("/generate/generators")).json()] == [
        "builtin"
    ]


async def test_bad_slots_are_a_400_not_a_crash(client, seed):
    _with_raw(seed, "L1:a.png", _graph("graph_hires_detailer.json"))
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    for bad in (
        {"per_request": "abc"},
        {"lora_model": 5},
        {"lora_model": ["x"]},
        {"seeds": [["3", ["seed"]]]},
    ):
        r = await client.post(
            "/generate/generators",
            json={
                "source": {"image_id": "L1:a.png"},
                "name": "X",
                "slots": {**d["slots"], **bad},
            },
        )
        assert r.status_code == 400, (bad, r.text)


async def test_saved_defaults_drive_the_edit_view(client, comfy, seed):  # noqa: F811
    gen = await _create(client, seed)
    await client.put(
        f"/generate/generators/{gen['_id']}",
        json={"defaults": {"base": "my base", "negative": "my neg", "junk": "x"}},
    )
    setup = (await client.get(f"/generate/generators/{gen['_id']}/setup")).json()
    assert setup["defaults"] == {"base": "my base", "negative": "my neg"}
    assert setup["base_without"] == "my base"
    assert "pins" not in setup["source"] and "defaults" not in setup["source"]


async def test_slots_locked_while_a_batch_runs(client, comfy, seed):  # noqa: F811
    gen = await _create(client, seed)
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.generators)
            .where(t.generators.c._id == gen["_id"])
            .values(ready=True)
        )
    r = await client.post(
        "/generate/batches", json={"generator_id": gen["_id"], "base": "x", "count": 8}
    )
    assert r.status_code == 200, r.text
    slots = {**gen["slots"], "seeds": [["16", "seed"]]}
    r = await client.put(f"/generate/generators/{gen['_id']}", json={"slots": slots})
    assert r.status_code == 400 and "batches" in r.json()["detail"]
    assert (
        await client.delete(f"/generate/generators/{gen['_id']}")
    ).status_code == 409


async def test_missing_models_are_proposed_out(client, comfy, seed):  # noqa: F811
    # The model index is loaded: none of the graph's own files are installed.
    await client.post("/generate/comfyui/test")
    _with_raw(seed, "L1:a.png", _graph("graph_hires_detailer.json"))
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    assert [lo["installed"] for lo in d["found"]["loras"]] == [False] * 4
    assert d["found"]["checkpoint"]["installed"] is False
    assert d["slots"]["drop_loras"] == ["40", "41", "42", "43"]
    assert d["slots"]["checkpoint"] == ["20", "ckpt_name"]
    r = await client.post(
        "/generate/generators",
        json={
            "source": {"image_id": "L1:a.png"},
            "name": "X",
            "slots": d["slots"],
            "defaults": d["defaults"],
        },
    )
    gen = r.json()
    await client.post(f"/generate/generators/{gen['_id']}/test", json={})
    sent = comfy.prompts[comfy.order[-1]]
    own = {
        k
        for k, n in sent.items()
        if n["inputs"].get("lora_name") in [lo["name"] for lo in d["found"]["loras"]]
    }
    assert own == set()
    # The test's own LoRA goes straight after the checkpoint now.
    added = next(k for k, n in sent.items() if n["class_type"] == "LoraLoader")
    assert sent[added]["inputs"]["model"] == ["20", 0]
    # Its checkpoint slot takes an installed one.
    assert sent["20"]["inputs"]["ckpt_name"] in comfy.checkpoints


async def test_prompts_carry_the_family_and_no_cached_text(client, comfy, seed):  # noqa: F811
    g = _graph("graph_runtime_prompt.json")
    _with_raw(seed, "L1:a.png", g)
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.image_gen_raw)
            .where(t.image_gen_raw.c._id == "L1:a.png")
            .values(
                raw={
                    "prompt": g,
                    "workflow": {
                        "id": "fam-1",
                        "nodes": [
                            {
                                "id": 11,
                                "type": "CLIPTextEncode",
                                "widgets_values": ["old prompt"],
                            }
                        ],
                    },
                }
            )
        )
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    slots = {**d["slots"], "positive": ["11", "text"], "replace_links": ["positive"]}
    gen = (
        await client.post(
            "/generate/generators",
            json={"source": {"image_id": "L1:a.png"}, "name": "X", "slots": slots},
        )
    ).json()
    await client.post(f"/generate/generators/{gen['_id']}/test", json={})
    pid = comfy.order[-1]
    # Its family in Moire's own chunk; no editor workflow (ComfyUI would
    # load that ahead of the prompt), so no old widget text either.
    assert comfy.extras[pid]["extra_pnginfo"] == {"moire": {"family": "fam-1"}}
    # The display node's cached text from the editor doesn't travel.
    assert comfy.prompts[pid]["22"]["inputs"]["text2"] == ""


def _version(seed, image_id: str, graph: dict, sig: str, mtime: float):
    seed(image_id, gen={"workflow_sig": sig}, mtime=mtime)
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=sig,
                raw={"prompt": graph, "workflow": {"id": "fam-1", "nodes": []}},
            )
        )


async def test_update_from_a_newer_version(client, seed):
    old = _graph("graph_hires_detailer.json")
    _version(seed, "L1:a.png", old, "sig-1", 1.0)
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    slots = {**d["slots"], "seeds": [["16", "seed"]]}
    gen = (
        await client.post(
            "/generate/generators",
            json={
                "source": {"image_id": "L1:a.png"},
                "name": "P",
                "slots": slots,
                "defaults": {"base": "mine", "negative": ""},
            },
        )
    ).json()
    assert (await client.get(f"/generate/generators/{gen['_id']}/latest")).json() == {
        "newer": None
    }

    # A newer version: the upscaler is gone and a node was added.
    new = {k: v for k, v in old.items() if k not in ("34", "35")}
    new["24"] = {**new["24"], "inputs": {**new["24"]["inputs"], "images": ["26", 0]}}
    _version(seed, "L1:b.png", new, "sig-2", 2.0)
    newer = (await client.get(f"/generate/generators/{gen['_id']}/latest")).json()[
        "newer"
    ]
    assert newer == {
        "image_id": "L1:b.png",
        "workflow_sig": "sig-2",
        "versions": 2,
    }

    s = (
        await client.get(
            f"/generate/generators/{gen['_id']}/setup", params={"image": "L1:b.png"}
        )
    ).json()
    # The user's seed choice carries over; the old upscaler's seed doesn't.
    assert s["slots"]["seeds"] == [["16", "seed"]]
    assert s["slots"]["positive"] == ["14", "text"]
    assert s["defaults"]["base"] == "mine"

    r = await client.put(
        f"/generate/generators/{gen['_id']}",
        json={"source": {"image_id": "L1:b.png"}, "slots": s["slots"]},
    )
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["ready"] is False and v["source"]["workflow_sig"] == "sig-2"
    assert v["defaults"]["base"] == "mine"
    assert (await client.get(f"/generate/generators/{gen['_id']}/latest")).json() == {
        "newer": None
    }


async def test_newer_version_ignores_moires_own_outputs_and_older_ones(client, seed):
    old = _graph("graph_hires_detailer.json")
    _version(seed, "L1:a.png", old, "sig-1", 1.0)
    _version(
        seed,
        "L1:b.png",
        {**old, "99": {"class_type": "Note", "inputs": {}}},
        "sig-2",
        2.0,
    )
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:b.png"}
        )
    ).json()
    gen = (
        await client.post(
            "/generate/generators",
            json={"source": {"image_id": "L1:b.png"}, "name": "P", "slots": d["slots"]},
        )
    ).json()
    # An older version used later isn't "newer".
    _version(seed, "L1:a2.png", old, "sig-1", 3.0)
    assert (await client.get(f"/generate/generators/{gen['_id']}/latest")).json() == {
        "newer": None
    }
    # Moire's own output (a graph it edited, a new signature) isn't either.
    _version(
        seed,
        "OUT:x.png",
        {**old, "98": {"class_type": "Note", "inputs": {}}},
        "sig-3",
        4.0,
    )
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.generation_batches).values(
                _id=900, name="b", generator_id=gen["_id"], inputs={}, state="done"
            )
        )
        conn.execute(
            sa.insert(t.generation_requests).values(
                _id=900, batch_id=900, idx=0, state="done", seed=1
            )
        )
        conn.execute(
            sa.insert(t.generation_outputs).values(
                request_id=900,
                idx=0,
                filename="x.png",
                subfolder="",
                image_id="OUT:x.png",
            )
        )
    assert (await client.get(f"/generate/generators/{gen['_id']}/latest")).json() == {
        "newer": None
    }


async def test_a_new_version_needs_its_slots(client, seed):
    old = _graph("graph_hires_detailer.json")
    _version(seed, "L1:a.png", old, "sig-1", 1.0)
    d = (
        await client.post(
            "/generate/generators/discover", json={"image_id": "L1:a.png"}
        )
    ).json()
    gen = (
        await client.post(
            "/generate/generators",
            json={"source": {"image_id": "L1:a.png"}, "name": "P", "slots": d["slots"]},
        )
    ).json()
    r = await client.put(
        f"/generate/generators/{gen['_id']}", json={"source": {"image_id": "L1:a.png"}}
    )
    assert r.status_code == 400


async def test_an_image_moire_made_joins_its_family(temp_db, seed):
    from moire.database.db import async_conn
    from moire.services import workflow_family

    _version(seed, "L1:a.png", _graph("graph_hires_detailer.json"), "sig-1", 1.0)
    seed("OUT:x.png", gen={"workflow_sig": "sig-9"}, mtime=2.0)
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id="OUT:x.png",
                library_id="OUT",
                workflow_sig="sig-9",
                raw={"prompt": {}, "workflow": None, "moire": {"family": "fam-1"}},
            )
        )
    async with async_conn() as conn:
        assert sorted(await workflow_family.family_sigs(conn, "fam-1")) == [
            "sig-1",
            "sig-9",
        ]
