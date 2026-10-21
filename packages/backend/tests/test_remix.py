"""Remix: what the composer starts from for a library image."""

from __future__ import annotations

import json
from pathlib import Path

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import recipes, remix, tag_categories

FIXTURES = Path(__file__).parent / "fixtures"


def test_strip_networks():
    assert remix.strip_networks("1girl, <lora:flat:0.7>, smile") == "1girl, smile"
    assert remix.strip_networks("<lora:a:1> 1girl") == "1girl"
    assert remix.strip_networks("plain, text") == "plain, text"
    assert remix.strip_networks("1girl <lora:flat:0.7> smile") == "1girl smile"
    # Separators away from a network stay as written.
    assert remix.strip_networks("a,\n\n, b, <lora:x:1>") == "a,\n\n, b"


def test_prompt_characters_first_seen_first():
    names = {"hu_tao_(genshin_impact)", "furina"}
    got = remix.prompt_characters(
        "furina, smile, hu tao \\(genshin impact\\), furina", names
    )
    assert got == ["furina", "hu_tao_(genshin_impact)"]


def test_a1111_size():
    assert remix.a1111_size("x\nSteps: 20, Size: 832x1216, Seed: 1") == (832, 1216)
    assert remix.a1111_size(None) is None


def test_graph_settings_reads_the_latent_not_the_output():
    g = json.loads((FIXTURES / "graph_hires_detailer.json").read_text())
    got = remix.graph_settings(g)
    assert got["size"] == (832, 1216)
    assert got["sampling"] == {
        "sampler": "euler",
        "scheduler": "normal",
        "steps": 40,
        "cfg": 5.0,
    }


def test_checked_sampling_drops_what_comfyui_lacks():
    have = {"sampler": ["euler"], "scheduler": ["normal"]}
    s = {"sampler": "DPM++ 2M Karras", "scheduler": "normal", "steps": 28, "cfg": 6}
    assert remix.checked_sampling(s, have) == {
        "scheduler": "normal",
        "steps": 28,
        "cfg": 6.0,
    }
    # Not connected yet: nothing to judge against.
    assert remix.checked_sampling({"sampler": "x"}, {"sampler": []}) == {"sampler": "x"}


def test_matched_loras_by_stem():
    used = [
        {"name": "flat_color_xl", "strength": 0.7},
        {"name": "styles/flat_color_xl.safetensors", "strength": 0.5},
        {"name": "gone", "strength": 1},
    ]
    table = {"flat_color_xl": "sdxl/flat_color_xl.safetensors", "gone": None}
    assert remix.matched_loras(used, table) == [
        {"name": "sdxl/flat_color_xl.safetensors", "strength": 0.7, "installed": True},
        {"name": "gone", "strength": 1.0, "installed": False},
    ]


def _image(seed, image_id, gen, raw):
    seed(image_id, gen=gen, width=1664, height=2432)
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=gen.get("workflow_sig"),
                raw=raw,
            )
        )


async def test_comfyui_image(client, seed, monkeypatch):
    g = json.loads((FIXTURES / "graph_hires_detailer.json").read_text())
    _image(
        seed,
        "L1:a.png",
        {
            "source": "comfyui",
            "workflow_sig": "sig-1",
            "prompt": "furina, white hair, blue eyes, maid, smile",
            "negative": "lowres",
            "seed": 42,
            "loras": [{"name": "flat_color_xl", "strength": 0.7}],
        },
        {"prompt": g, "workflow": {"id": "fam-1", "nodes": []}},
    )
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.workflow_names).values(workflow_id="fam-1", name="Portrait")
        )

    async def vocab():
        return tag_categories.vocab({"furina"}, set())

    async def recipe(tag):
        assert tag == "furina"
        return {
            "tag": "furina",
            "identity": [
                {"tag": "white_hair", "dropped": False},
                {"tag": "blue_eyes", "dropped": True},
            ],
        }

    monkeypatch.setattr(tag_categories, "load", vocab)
    monkeypatch.setattr(recipes, "recipe", recipe)
    r = await client.get("/generate/remix/L1:a.png?full=1")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["workflow"] == {
        "family": "fam-1",
        "family_name": "Portrait",
        "file_name": None,
        "workflow_sig": "sig-1",
    }
    assert d["characters"] == ["furina"]
    # The name and the identity the block adds back go; a dropped identity
    # chip and worn things stay.
    assert d["prompt"] == "blue eyes, maid, smile"
    assert d["negative"] == "lowres"
    assert d["seed"] == 42
    assert (d["width"], d["height"]) == (832, 1216)
    assert d["sampling"]["steps"] == 40
    assert d["loras"] == [
        {"name": "flat_color_xl", "strength": 0.7, "installed": False}
    ]
    assert d["batch"] is None


async def test_a1111_image(client, seed):
    params = "1girl, <lora:flat:0.7>, smile\nNegative prompt: bad\nSteps: 20, Sampler: Euler a, CFG scale: 6, Seed: 7, Size: 512x768, Model: anything"
    _image(
        seed,
        "L1:b.png",
        {
            "source": "a1111",
            "prompt": "1girl, <lora:flat:0.7>, smile",
            "negative": "bad",
            "seed": 7,
            "steps": 20,
            "cfg": 6.0,
        },
        {"source": "a1111", "parameters": params},
    )
    d = (await client.get("/generate/remix/L1:b.png?full=1")).json()
    assert d["workflow"] is None
    assert d["prompt"] == "1girl, smile"
    assert (d["width"], d["height"]) == (512, 768)
    assert d["checkpoint"] is None


async def test_moire_output_names_its_batch(client, seed):
    _image(seed, "OUT:c.png", {"source": "comfyui", "prompt": "x", "seed": 9}, {})
    with db.sync_tx() as conn:
        bid = conn.execute(
            sa.insert(t.generation_batches).values(
                name="Batch 1",
                generator_id="builtin",
                inputs={"count": 2},
                state="done",
            )
        ).inserted_primary_key[0]
        rid = conn.execute(
            sa.insert(t.generation_requests).values(
                batch_id=bid, idx=0, seed=9, images=2, state="done"
            )
        ).inserted_primary_key[0]
        conn.execute(
            sa.insert(t.generation_outputs).values(
                request_id=rid, idx=1, filename="c.png", image_id="OUT:c.png"
            )
        )
    d = (await client.get("/generate/remix/OUT:c.png")).json()
    assert d["batch"]["generator_id"] == "builtin"
    assert (d["batch"]["seed"], d["batch"]["images"], d["batch"]["index"]) == (9, 2, 1)


async def test_light_read_and_backslash_ids(client, seed):
    _image(seed, "L1:sub/e.png", {"source": "comfyui", "prompt": "x", "seed": 3}, {})
    d = (await client.get("/generate/remix/L1:sub\\e.png")).json()
    assert d["image_id"] == "L1:sub/e.png"
    assert "prompt" not in d


def test_linked_sampling_keeps_the_scanned_value():
    g = {
        "1": {
            "class_type": "KSampler",
            "inputs": {
                "steps": 30,
                "cfg": ["9", 0],
                "sampler_name": "euler",
                "scheduler": "normal",
                "latent_image": ["2", 0],
                "seed": 1,
                "model": ["3", 0],
                "positive": ["4", 0],
                "negative": ["5", 0],
                "denoise": 1,
            },
        },
    }
    assert "cfg" not in remix.graph_settings(g)["sampling"]


async def test_no_generation_data(client, seed):
    seed("L1:d.png")
    assert (await client.get("/generate/remix/L1:d.png")).status_code == 404
