"""Generation end to end against a fake ComfyUI: settings, test-run gate,
batching into requests, failures, retry, cancel, lost, connection down."""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from moire.services import comfy_settings, generation_jobs
from moire.services.generation_jobs import get_generation_manager
from tests.fake_comfy import FakeComfy

OUT = "OUT"


@pytest_asyncio.fixture
async def comfy(temp_db):
    generation_jobs.reset_for_tests()
    fake = FakeComfy()
    m = get_generation_manager()
    m.transport = fake.transport()
    await comfy_settings.update_settings(
        {"address": "http://fake", "output_library_id": OUT}
    )
    await m.configure()
    yield fake
    await m.stop()
    generation_jobs.reset_for_tests()


def scanned(seed, paths):
    """What the output library's scan does once ComfyUI writes the files."""
    for p in paths:
        seed(f"{OUT}:{p}", library_id=OUT, width=832, height=1216)


async def tick():
    await get_generation_manager().tick()


async def make_ready(client, fake, seed):
    r = await client.post("/generate/generators/builtin/test", json={})
    assert r.status_code == 200, r.text
    pid = fake.order[-1]
    await asyncio.to_thread(scanned, seed, fake.finish(pid, images=1))
    await tick()
    g = (await client.get("/generate/generators/builtin")).json()
    assert g["ready"] is True
    return pid


async def test_connection_and_models(client, comfy):
    r = await client.post("/generate/comfyui/test")
    assert r.json()["ok"] is True and r.json()["connected"] is True
    models = (await client.get("/generate/comfyui/models")).json()
    assert models["checkpoints"] == sorted(comfy.checkpoints, key=str.lower)
    assert "styles/flat_color_xl.safetensors" in models["loras"]
    assert models["embeddings"] == ["easynegative", "pos/aesthetic"]
    # ComfyUI's own order, not sorted.
    assert models["samplers"] == ["euler", "euler_ancestral", "dpmpp_2m"]
    assert models["schedulers"] == ["normal", "karras"]


async def test_headers_are_masked_and_kept(client, comfy):
    r = await client.put(
        "/generate/comfyui", json={"headers": {"Authorization": "Bearer secret"}}
    )
    assert r.json()["headers"] == {"Authorization": "••••"}
    await client.put(
        "/generate/comfyui", json={"headers": {"Authorization": "••••", "X-Other": "1"}}
    )
    s = await comfy_settings.get_settings()
    assert s["headers"] == {"Authorization": "Bearer secret", "X-Other": "1"}
    assert "secret" not in (await client.get("/generate/comfyui")).text


async def test_queue_refused_until_test_run_passes(client, comfy, seed):
    r = await client.post("/generate/batches", json={"base": "1girl"})
    assert r.status_code == 400
    pid = await make_ready(client, comfy, seed)
    # The test chains one installed LoRA at strength 0.
    loras = [n for n in comfy.prompts[pid].values() if n["class_type"] == "LoraLoader"]
    assert len(loras) == 1 and loras[0]["inputs"]["strength_model"] == 0.0
    # Test runs stay out of the Generations list.
    assert (await client.get("/generate/batches")).json() == []


async def test_eight_images_at_two_per_request(client, comfy, seed):
    await make_ready(client, comfy, seed)
    await comfy_settings.update_settings({"builtin_per_request": 2})
    r = await client.post(
        "/generate/batches",
        json={
            "base": "masterpiece",
            "extra": ["red_dress", "night", "embedding:easynegative"],
            "loras": [{"name": "styles/flat_color_xl.safetensors", "strength": 0.8}],
            "checkpoint": "illustriousXL_v01.safetensors",
            "width": 832,
            "height": 1216,
            "seed": {"mode": "fixed", "value": 100},
            "count": 8,
        },
    )
    assert r.status_code == 200, r.text
    batch = r.json()
    assert batch["name"] == "Built-in, red dress, night"
    active = (await client.get("/generate/status")).json()["active"]
    assert [(a["name"], a["requests"], a["finished"]) for a in active] == [
        ("Built-in, red dress, night", 4, 0)
    ]
    # A frame per image asked, at the batch's size, none made yet.
    assert len(active[0]["frames"]) == 8
    assert {f["state"] for f in active[0]["frames"]} == {"waiting"}
    assert (active[0]["width"], active[0]["height"]) == (832, 1216)
    assert [q["images"] for q in batch["requests"]] == [2, 2, 2, 2]
    assert [q["seed"] for q in batch["requests"]] == [100, 101, 102, 103]
    assert [q["state"] for q in batch["requests"]] == [
        "queued",
        "pending",
        "pending",
        "pending",
    ]

    first = comfy.order[-1]
    g = comfy.prompts[first]
    assert (
        g["6"]["inputs"]["text"]
        == "masterpiece, red_dress, night, embedding:easynegative"
    )
    assert g["5"]["inputs"]["batch_size"] == 2 and g["3"]["inputs"]["seed"] == 100

    # One request in ComfyUI at a time; each finish submits the next.
    for _ in range(4):
        pid = comfy.order[-1]
        scanned(seed, comfy.finish(pid))
        await tick()
    batch = (await client.get(f"/generate/batches/{batch['_id']}")).json()
    assert batch["state"] == "done"
    assert all(
        len(q["outputs"]) == 2 and all(o["in_library"] for o in q["outputs"])
        for q in batch["requests"]
    )
    listed = (await client.get("/generate/batches")).json()
    assert listed[0]["images"] == 8 and listed[0]["kept"] == 8


async def test_extra_images_are_kept_and_zero_is_reported(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x", "count": 2})).json()
    scanned(seed, comfy.finish(comfy.order[-1], images=3))
    await tick()
    comfy.finish(comfy.order[-1], images=0)
    await tick()
    reqs = (await client.get(f"/generate/batches/{b['_id']}")).json()["requests"]
    assert [len(q["outputs"]) for q in reqs] == [3, 0]
    assert [q["state"] for q in reqs] == ["done", "done"]


async def test_first_request_rejected_keeps_nothing(client, comfy, seed):
    await make_ready(client, comfy, seed)
    comfy.reject_next = {
        "error": {"message": "Prompt outputs failed validation"},
        "node_errors": {
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "errors": [
                    {
                        "type": "value_not_in_list",
                        "message": "Value not in list",
                        "details": "ckpt_name",
                        "extra_info": {"input_name": "ckpt_name"},
                    }
                ],
            }
        },
    }
    r = await client.post(
        "/generate/batches", json={"base": "x", "checkpoint": "gone.safetensors"}
    )
    assert r.status_code == 422
    assert r.json()["node_errors"][0]["input"] == "ckpt_name"
    assert (await client.get("/generate/batches")).json() == []


async def test_failure_retry_one_at_a_time(client, comfy, seed):
    await make_ready(client, comfy, seed)
    await comfy_settings.update_settings({"builtin_per_request": 2})
    b = (await client.post("/generate/batches", json={"base": "x", "count": 2})).json()
    comfy.fail(comfy.order[-1])
    await tick()
    batch = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert batch["state"] == "failed"
    req = batch["requests"][0]
    assert (
        req["error"]["message"] == "CUDA out of memory" and req["error"]["node"] == "3"
    )

    r = await client.post(
        f"/generate/batches/{b['_id']}/requests/{req['_id']}/retry",
        json={"single": True},
    )
    reqs = r.json()["requests"]
    assert [(q["images"], q["state"]) for q in reqs] == [(1, "pending"), (1, "pending")]
    await tick()
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    assert (await client.get(f"/generate/batches/{b['_id']}")).json()["state"] == "done"


async def test_cancel_pending_and_interrupt_running(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x", "count": 3})).json()
    pid = comfy.order[-1]
    comfy.start(pid)
    await tick()
    r = await client.post(f"/generate/batches/{b['_id']}/cancel")
    assert [q["state"] for q in r.json()["requests"]] == [
        "running",
        "cancelled",
        "cancelled",
    ]
    assert comfy.interrupted == [pid]
    comfy.history[pid] = {
        "outputs": {},
        "status": {"status_str": "error", "messages": [["execution_interrupted", {}]]},
    }
    comfy.running.remove(pid)
    await tick()
    assert (await client.get(f"/generate/batches/{b['_id']}")).json()[
        "state"
    ] == "cancelled"


async def test_lost_when_comfyui_forgets_the_prompt(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x"})).json()
    comfy.pending.clear()  # ComfyUI restarted: in neither queue nor history
    await tick()
    batch = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert batch["requests"][0]["state"] == "lost"
    assert batch["state"] == "failed"


async def test_connection_down_pauses_and_refuses(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x", "count": 2})).json()
    comfy.up = False
    await tick()
    assert (await client.get("/generate/status")).json()["connected"] is False
    assert (await client.get(f"/generate/batches/{b['_id']}")).json()[
        "state"
    ] == "paused"
    assert (
        await client.post("/generate/batches", json={"base": "y"})
    ).status_code == 503
    comfy.up = True
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    assert (await client.get(f"/generate/batches/{b['_id']}")).json()[
        "state"
    ] == "running"


async def test_rename_and_requeue(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (
        await client.post("/generate/batches", json={"base": "x", "extra": ["a"]})
    ).json()
    r = await client.patch(f"/generate/batches/{b['_id']}", json={"name": "Keepers"})
    assert r.json()["name"] == "Keepers" and r.json()["auto_name"] is False
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    r = await client.post(f"/generate/batches/{b['_id']}/requeue")
    assert (
        r.status_code == 200
        and r.json()["_id"] != b["_id"]
        and r.json()["name"] == "Keepers"
    )


async def test_manager_starts_with_comfyui_down(temp_db):
    generation_jobs.reset_for_tests()
    fake = FakeComfy()
    fake.up = False
    m = get_generation_manager()
    m.transport = fake.transport()
    m.ws_connect = fake.connect
    await comfy_settings.update_settings({"address": "http://fake"})
    m.start()
    await asyncio.sleep(0.05)
    assert m.status()["configured"] is True and m.status()["connected"] is False
    assert not m._loop_task.done()  # type: ignore[union-attr]
    await m.stop()
    generation_jobs.reset_for_tests()


@pytest.mark.parametrize(
    "states,connected,expected",
    [
        (["done", "running"], True, "running"),
        (["done", "queued"], False, "paused"),
        (["done", "lost"], True, "failed"),
        (["cancelled"], True, "cancelled"),
    ],
)
def test_batch_state(states, connected, expected):
    from moire.services.generation_batches import batch_state

    assert batch_state(states, connected) == expected


async def test_live_loop_never_double_submits_or_loses(client, comfy, seed):
    """The background loop runs while the API queues: no prompt is sent twice,
    none is called lost."""
    m = get_generation_manager()
    m.transport = comfy.transport(latency=0.005)
    await m.configure()
    m.ws_connect = comfy.connect
    m.start()
    await make_ready(client, comfy, seed)
    m.interval = m.idle_interval = 0.001
    sent_before = len(comfy.order)
    posts = await asyncio.gather(
        *(
            client.post("/generate/batches", json={"base": "x", "count": 2})
            for _ in range(5)
        )
    )
    ids = [p.json()["_id"] for p in posts]
    for _ in range(500):
        await asyncio.sleep(0.005)
        if comfy.pending:
            # Off the event loop: the seed helper's sync write would otherwise
            # block the loop's own async transaction until busy_timeout.
            files = comfy.finish(comfy.pending[0])
            await asyncio.to_thread(scanned, seed, files)
        states = [
            (await client.get(f"/generate/batches/{i}")).json()["state"] for i in ids
        ]
        if all(st != "running" for st in states):
            break
    assert states == ["done"] * 5
    # Ten images; a batch queued behind others is sent once to be checked,
    # then taken back (deleted) until its turn.
    assert len(comfy.order) - sent_before - len(comfy.deleted) == 10


async def test_rejection_maps_errors_to_fields(client, comfy, seed):
    await make_ready(client, comfy, seed)
    comfy.reject_next = {
        "error": {"message": "Prompt outputs failed validation"},
        "node_errors": {
            "4": {
                "class_type": "CheckpointLoaderSimple",
                "errors": [
                    {"type": "value_not_in_list", "message": "Value not in list"}
                ],
            },
            "10": {
                "class_type": "LoraLoader",
                "errors": [
                    {"type": "value_not_in_list", "message": "Value not in list"}
                ],
            },
        },
    }
    r = await client.post(
        "/generate/batches",
        json={"base": "x", "loras": [{"name": "gone.safetensors", "strength": 1}]},
    )
    errs = {e["node"]: e for e in r.json()["node_errors"]}
    assert errs["4"]["field"] == "checkpoint"
    assert {k: errs["10"][k] for k in ("field", "lora_name", "added")} == {
        "field": "lora",
        "lora_name": "gone.safetensors",
        "added": True,
    }


async def test_retry_refuses_a_request_that_returned_images(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x"})).json()
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    rid = b["requests"][0]["_id"]
    r = await client.post(f"/generate/batches/{b['_id']}/requests/{rid}/retry", json={})
    assert r.status_code == 400


async def test_cancel_one_request_leaves_the_rest(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x", "count": 3})).json()
    second = b["requests"][1]["_id"]
    r = await client.post(f"/generate/batches/{b['_id']}/requests/{second}/cancel")
    assert [q["state"] for q in r.json()["requests"]] == [
        "queued",
        "cancelled",
        "pending",
    ]
    assert comfy.interrupted == []
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    reqs = (await client.get(f"/generate/batches/{b['_id']}")).json()["requests"]
    assert [q["state"] for q in reqs] == ["done", "cancelled", "queued"]


async def test_outputs_ComfyUI_wrote_elsewhere_are_downloaded(
    client, comfy, seed, tmp_path
):
    """A remote ComfyUI: the output folder here starts empty, so each output
    is fetched over /view into it; one already there is left alone."""
    import sqlalchemy as sa
    from moire.database import db
    from moire.database import schema as t

    out = tmp_path / "out"
    out.mkdir()
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries).values(_id=OUT, path=str(out), name="ComfyUI output")
        )
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x"})).json()
    pid = comfy.order[-1]
    (out / "moire").mkdir(exist_ok=True)
    (out / "moire" / f"gen_{pid}_00000_.png").write_bytes(b"local")
    comfy.finish(pid, images=2)
    await tick()
    assert (out / "moire" / f"gen_{pid}_00000_.png").read_bytes() == b"local"
    assert (
        out / "moire" / f"gen_{pid}_00001_.png"
    ).read_bytes() == f"PNG:gen_{pid}_00001_.png".encode()
    assert not [p for p in (out / "moire").iterdir() if p.name.startswith(".")]
    assert b["_id"]


async def test_bad_certificate_path_is_refused(client, comfy):
    r = await client.put("/generate/comfyui", json={"ca_cert": "/nope/cert.pem"})
    assert r.status_code == 400


async def test_download_can_be_turned_off(client, comfy, seed, tmp_path):
    import sqlalchemy as sa
    from moire.database import db
    from moire.database import schema as t

    out = tmp_path / "out"
    out.mkdir()
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries).values(_id=OUT, path=str(out), name="ComfyUI output")
        )
    await client.put("/generate/comfyui", json={"download_outputs": False})
    await make_ready(client, comfy, seed)
    assert not any(out.rglob("*.png"))


async def test_outputs_a_library_already_holds_link_there(
    client, comfy, seed, tmp_path
):
    """A local ComfyUI whose output folder isn't the output library: its
    folder is found from the library holding the first output, the outputs
    link to that library's files and nothing is downloaded."""
    import sqlalchemy as sa
    from moire.database import db
    from moire.database import schema as t

    out, comfy_out = tmp_path / "out", tmp_path / "ComfyUI" / "output"
    out.mkdir()
    (comfy_out / "moire").mkdir(parents=True)
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries),
            [
                {"_id": OUT, "path": str(out), "name": "ComfyUI output"},
                {"_id": "MOIRE", "path": str(comfy_out / "moire"), "name": "moire"},
            ],
        )
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x"})).json()
    pid = comfy.order[-1]
    names = [f"gen_{pid}_{i:05}_.png" for i in range(2)]
    for n in names:
        (comfy_out / "moire" / n).write_bytes(b"PNG:" + n.encode())
    comfy.finish(pid, images=2)
    await tick()
    got = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert [o["image_id"] for o in got["requests"][0]["outputs"]] == [
        f"MOIRE:{n}" for n in names
    ]
    assert not [n for n in names if (out / "moire" / n).exists()]
    assert (await comfy_settings.get_settings())["output_root"] == str(comfy_out)

    # Another ComfyUI: its folder is found again.
    await client.put("/generate/comfyui", json={"address": "http://other"})
    assert (await comfy_settings.get_settings())["output_root"] == ""


async def test_output_folder_can_be_set_by_hand(client, comfy, tmp_path):
    r = await client.put(
        "/generate/comfyui", json={"output_root": str(tmp_path / "nope")}
    )
    assert r.status_code == 400
    r = await client.put("/generate/comfyui", json={"output_root": str(tmp_path)})
    assert r.json()["output_root"] == str(tmp_path)


def test_held_by_is_the_innermost_library(tmp_path):
    from moire.services.generation_jobs import held_by, root_candidates

    root = tmp_path / "output"
    (root / "Unorganized10").mkdir(parents=True)
    (root / "Unorganized10" / "img_1.png").write_bytes(b"x")
    libs = [
        ("OUTER", str(root)),
        ("U10", str(root / "Unorganized10")),
        ("ELSE", str(tmp_path / "else")),
    ]
    assert held_by(libs, str(root / "Unorganized10" / "img_1.png")) == "U10:img_1.png"
    assert held_by(libs, str(root / "a.png")) == "OUTER:a.png"
    assert held_by(libs[1:], str(root / "a.png")) is None
    assert root_candidates(libs[1:], "Unorganized10", "img_1.png") == [str(root)]
    assert root_candidates(libs, "Unorganized10", "img_1.png") == [str(root)]
    assert root_candidates(libs[1:], "Other", "img_1.png") == []
    # Older than the run: another run's file with the same name.
    import os

    os.utime(root / "Unorganized10" / "img_1.png", (1, 1))
    assert root_candidates(libs[1:], "Unorganized10", "img_1.png", since=100) == []


async def test_an_unwatched_library_doesnt_take_outputs(client, comfy, seed, tmp_path):
    """Nothing would pick the file up there: it downloads as before."""
    import sqlalchemy as sa
    from moire.database import db
    from moire.database import schema as t

    out, comfy_out = tmp_path / "out", tmp_path / "ComfyUI" / "output"
    out.mkdir()
    (comfy_out / "moire").mkdir(parents=True)
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries),
            [
                {
                    "_id": OUT,
                    "path": str(out),
                    "name": "ComfyUI output",
                    "watch_enabled": True,
                },
                {
                    "_id": "MOIRE",
                    "path": str(comfy_out / "moire"),
                    "name": "moire",
                    "watch_enabled": False,
                },
            ],
        )
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x"})).json()
    pid = comfy.order[-1]
    name = f"gen_{pid}_00000_.png"
    (comfy_out / "moire" / name).write_bytes(b"PNG:" + name.encode())
    comfy.finish(pid, images=1)
    await tick()
    got = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert got["requests"][0]["outputs"][0]["image_id"] == f"{OUT}:moire/{name}"
    assert (out / "moire" / name).exists()


async def test_sampling_reaches_the_sampler_and_requeue_keeps_it(client, comfy, seed):
    await make_ready(client, comfy, seed)
    g = (await client.get("/generate/generators/builtin")).json()
    assert g["sampling"] == {
        "sampler": "euler_ancestral",
        "scheduler": "normal",
        "steps": 28,
        "cfg": 6.0,
    }
    # Only what was set changes; the rest stays as the graph has it.
    b = (
        await client.post(
            "/generate/batches",
            json={"base": "x", "sampling": {"sampler": "dpmpp_2m", "steps": 20}},
        )
    ).json()
    ks = comfy.prompts[comfy.order[-1]]["3"]["inputs"]
    assert (ks["sampler_name"], ks["steps"], ks["cfg"], ks["scheduler"]) == (
        "dpmpp_2m",
        20,
        6.0,
        "normal",
    )
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    await client.post(f"/generate/batches/{b['_id']}/requeue")
    ks = comfy.prompts[comfy.order[-1]]["3"]["inputs"]
    assert (ks["sampler_name"], ks["steps"]) == ("dpmpp_2m", 20)
    bad = await client.post(
        "/generate/batches", json={"base": "x", "sampling": {"steps": 0}}
    )
    assert bad.status_code == 422


async def test_images_per_request_for_one_batch(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (
        await client.post(
            "/generate/batches", json={"base": "x", "count": 7, "per_request": 3}
        )
    ).json()
    assert comfy.prompts[comfy.order[-1]]["5"]["inputs"]["batch_size"] == 3
    got = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert [q["images"] for q in got["requests"]] == [3, 3, 1]
    assert got["inputs"]["per_request"] == 3


def test_only_a_sampling_input_flags_sampling():
    from moire.services import builtin_generator

    gen = {"slots": builtin_generator.slots(), "graph": builtin_generator.graph()}
    errs = [
        {"node": "3", "input": "steps"},
        {"node": "3", "input": "seed"},
    ]
    out = generation_jobs.annotate_node_errors(errs, gen, gen["graph"])
    assert [e["field"] for e in out] == ["sampling", None]


async def test_time_comfyui_spent_is_kept(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x"})).json()
    got = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert got["requests"][0]["ran"] is None
    scanned(seed, comfy.finish(comfy.order[-1]))
    await tick()
    got = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert got["requests"][0]["ran"] == 12.5


def test_run_seconds_needs_both_ends():
    msg = lambda kind, ts: [kind, {"timestamp": ts}]  # noqa: E731
    entry = lambda *m: {"status": {"messages": list(m)}}  # noqa: E731
    run = generation_jobs.run_seconds
    assert run(entry(msg("execution_start", 1000), msg("execution_error", 4000))) == 3
    assert run(entry(msg("execution_start", 1000))) is None
    assert run(entry(msg("execution_success", 1000))) is None
    assert run({}) is None


async def test_requeue_replays_a_chosen_batch_size_not_the_setting(client, comfy, seed):
    await make_ready(client, comfy, seed)
    plain = (
        await client.post("/generate/batches", json={"base": "x", "count": 2})
    ).json()
    await comfy_settings.update_settings({"builtin_per_request": 2})
    again = (await client.post(f"/generate/batches/{plain['_id']}/requeue")).json()
    got = (await client.get(f"/generate/batches/{again['_id']}")).json()
    # Queued at the old setting (1), requeued at today's (2).
    assert [q["images"] for q in got["requests"]] == [2]
    assert got["inputs"]["per_request_asked"] is None


async def test_outputs_are_found_when_the_output_library_comes_back(client, tmp_path):
    """A library removed and added again keeps its id (it comes from the
    folder), so its generations, keyed by that id, find their images again
    instead of waiting for a scan that never matches."""
    import sqlalchemy as sa

    from moire.database import schema as t
    from moire.database.db import async_tx
    from moire.services.generation_jobs import output_image_id

    out = tmp_path / "out"
    out.mkdir()
    assert (
        await client.put("/generate/comfyui", json={"output_path": str(out)})
    ).status_code == 200
    lib = (await comfy_settings.get_settings())["output_library_id"]
    async with async_tx() as conn:
        await conn.execute(
            sa.insert(t.generation_batches).values(
                _id=1,
                generator_id="builtin",
                name="b",
                inputs={},
                state="done",
                created_at=0,
            )
        )
        await conn.execute(
            sa.insert(t.generation_requests).values(
                _id=1, batch_id=1, idx=0, state="done"
            )
        )
        await conn.execute(
            sa.insert(t.generation_outputs).values(
                request_id=1,
                idx=0,
                filename="a.png",
                subfolder="",
                image_id=output_image_id(lib, "", "a.png"),
            )
        )

    await client.delete(f"/libraries/{lib}")
    again = (await client.post("/libraries", json={"path": str(out)})).json()
    assert again["_id"] == lib
    # Re-pointing Generate at the folder lands on the same library too.
    await client.put("/generate/comfyui", json={"output_path": str(out)})
    assert (await comfy_settings.get_settings())["output_library_id"] == lib


async def test_estimate_learns_from_runs_and_counts_checkpoint_loads(
    client, comfy, seed
):
    await make_ready(client, comfy, seed)
    body = {
        "base": "x",
        "checkpoint": "a.safetensors",
        "width": 832,
        "height": 1216,
        "count": 3,
    }
    # No history yet: no number.
    first = (await client.post("/generate/estimate", json=body)).json()
    assert first["seconds"] is None and first["ahead"] == 0

    await client.post("/generate/batches", json=body)
    # The first run loads the checkpoint (its loader, node 4, isn't cached).
    for cached, seconds in ((["9"], 30), (["4"], 10), (["4"], 10)):
        pid = comfy.order[-1]
        scanned(seed, comfy.finish(pid, seconds=seconds, cached=cached))
        await tick()

    same = (await client.post("/generate/estimate", json=body)).json()
    assert same == {
        "seconds": 30,
        "load": None,
        "ahead": 0,
        "basis": "exact",
        "samples": 2,
    }
    other = (
        await client.post(
            "/generate/estimate", json={**body, "checkpoint": "b.safetensors"}
        )
    ).json()
    # Scaled from the Generator's other checkpoint, plus one load (30 - 10).
    assert other["basis"] == "generator"
    assert other["seconds"] == pytest.approx(50)
    assert other["load"] == pytest.approx(20)

    # Queued work shows up as time left, and ahead of a new batch.
    b = (await client.post("/generate/batches", json={**body, "count": 2})).json()
    status = (await client.get("/generate/status")).json()
    assert status["eta"] == pytest.approx(20, abs=1)
    assert status["active"][0]["eta"] == pytest.approx(20, abs=1)
    got = (await client.get(f"/generate/batches/{b['_id']}")).json()
    assert [q["expected"] for q in got["requests"]] == [10, 10]
    ahead = (await client.post("/generate/estimate", json=body)).json()["ahead"]
    assert ahead == pytest.approx(20, abs=1)

    await tick()
    items = (await client.get("/activity")).json()["items"]
    gen = next(i for i in items if i["kind"] == "generate")
    assert gen["eta_s"] == pytest.approx(20, abs=1)

    # Batch after batch: a second one starts once the first is done.
    c = (await client.post("/generate/batches", json={**body, "count": 2})).json()
    await tick()
    active = {
        a["_id"]: a for a in (await client.get("/generate/status")).json()["active"]
    }
    first, second = active[b["_id"]], active[c["_id"]]
    assert second["eta"] == pytest.approx(20, abs=1)
    assert first["starts_in"] == pytest.approx(0, abs=1)
    assert first["done_in"] == pytest.approx(20, abs=1)
    assert second["starts_in"] == pytest.approx(20, abs=1)
    assert second["done_in"] == pytest.approx(40, abs=1)
    assert first["running"] is False and second["running"] is False


async def test_a_failed_setup_at_startup_is_retried(temp_db, monkeypatch):
    """The certificate's drive not mounted yet at boot: the connection is set
    up on a later tick, not only when someone presses Test."""
    generation_jobs.reset_for_tests()
    fake = FakeComfy()
    m = get_generation_manager()
    m.transport = fake.transport()
    await comfy_settings.update_settings(
        {"address": "http://fake", "output_library_id": OUT}
    )
    real = generation_jobs.ComfyClient
    calls = {"n": 0}

    def flaky(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("ca file not found")
        return real(*a, **kw)

    monkeypatch.setattr(generation_jobs, "ComfyClient", flaky)
    await m._set_up()
    assert m.status()["configured"] is False
    assert "Couldn't set up the connection" in m.status()["error"]
    # Not every tick: after the wait.
    await m.tick()
    assert calls["n"] == 1
    m._setup_retry_at = 0.0
    await m.tick()
    assert m.status()["configured"] is True and m.status()["connected"] is True
    await m.stop()
    generation_jobs.reset_for_tests()


def test_slot_value_is_the_graphs_own_value():
    from moire.services.generator_graph import slot_value

    graph = {"86": {"inputs": {"value": "anima.safetensors", "link": ["3", 0]}}}
    assert slot_value(graph, ["86", "value"]) == "anima.safetensors"
    assert slot_value(graph, ["86", "link"]) is None
    assert slot_value(graph, ["9", "value"]) is None
    assert slot_value(graph, None) is None


async def test_running_time_counts_without_the_websocket(client, comfy, seed):
    # The start event never arrives (the websocket is down or reconnecting):
    # the queue poll still marks when the request started.
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "x", "count": 1})).json()
    pid = comfy.order[-1]
    comfy.pending.remove(pid)
    comfy.running.append(pid)
    await tick()
    q = (await client.get(f"/generate/batches/{b['_id']}")).json()["requests"][0]
    assert q["state"] == "running"
    assert q["elapsed"] is not None and q["elapsed"] >= 0


async def test_batches_run_one_after_another(client, comfy, seed):
    await make_ready(client, comfy, seed)
    a = (await client.post("/generate/batches", json={"base": "a", "count": 2})).json()
    b = (await client.post("/generate/batches", json={"base": "b", "count": 2})).json()
    # B's first went to ComfyUI to be checked, then came back to wait for A.
    assert [q["state"] for q in b["requests"]] == ["pending", "pending"]
    assert len(comfy.pending) == 1
    ran = []
    for _ in range(4):
        pid = comfy.pending[0]
        ran.append(comfy.prompts[pid]["6"]["inputs"]["text"])
        scanned(seed, comfy.finish(pid))
        await tick()
    assert ran == ["a", "a", "b", "b"]
    for x in (a, b):
        assert (await client.get(f"/generate/batches/{x['_id']}")).json()[
            "state"
        ] == "done"


async def test_a_test_run_goes_ahead_of_waiting_batches(client, comfy, seed):
    await make_ready(client, comfy, seed)
    await client.post("/generate/batches", json={"base": "a", "count": 2})
    await client.post("/generate/batches", json={"base": "b"})
    r = await client.post("/generate/generators/builtin/test", json={})
    assert r.status_code == 200, r.text
    # The test stays in ComfyUI's queue, behind A's image being made.
    assert len(comfy.pending) == 2
    ran = []
    for _ in range(4):
        pid = comfy.pending[0]
        ran.append(comfy.prompts[pid]["6"]["inputs"]["text"])
        scanned(seed, comfy.finish(pid))
        await tick()
    assert ran[0] == "a" and ran[2:] == ["a", "b"]


async def test_cancelling_a_batch_that_never_ran_deletes_it(client, comfy, seed):
    await make_ready(client, comfy, seed)
    await client.post("/generate/batches", json={"base": "a"})
    b = (await client.post("/generate/batches", json={"base": "b", "count": 2})).json()
    r = await client.post(f"/generate/batches/{b['_id']}/cancel")
    assert r.status_code == 200 and r.json() is None
    assert (await client.get(f"/generate/batches/{b['_id']}")).status_code == 404


async def test_a_retry_on_an_older_batch_waits_for_the_one_being_made(
    client, comfy, seed
):
    await make_ready(client, comfy, seed)
    a = (await client.post("/generate/batches", json={"base": "a"})).json()
    comfy.fail(comfy.order[-1])
    await tick()
    await client.post("/generate/batches", json={"base": "b", "count": 3})
    scanned(seed, comfy.finish(comfy.pending[0]))
    await tick()
    await client.post(
        f"/generate/batches/{a['_id']}/requests/{a['requests'][0]['_id']}/retry",
        json={},
    )
    ran = []
    for _ in range(3):
        pid = comfy.pending[0]
        ran.append(comfy.prompts[pid]["6"]["inputs"]["text"])
        scanned(seed, comfy.finish(pid))
        await tick()
    assert ran == ["b", "b", "a"]


async def test_a_parked_prompt_that_already_ran_is_not_sent_again(client, comfy, seed):
    await make_ready(client, comfy, seed)
    await client.post("/generate/batches", json={"base": "a", "count": 2})
    # ComfyUI makes B's first before the take-back lands: it's in history.
    nxt = f"p{len(comfy.order) + 1}"
    comfy.history[nxt] = {"outputs": {}, "status": {"status_str": "success"}}
    b = (await client.post("/generate/batches", json={"base": "b"})).json()
    assert b["requests"][0]["state"] == "queued"


async def test_cancelling_a_batch_already_sent_keeps_it(client, comfy, seed):
    await make_ready(client, comfy, seed)
    b = (await client.post("/generate/batches", json={"base": "a"})).json()
    r = await client.post(f"/generate/batches/{b['_id']}/cancel")
    # In ComfyUI's hands, so it may be running already: kept, cancelled.
    assert r.json()["requests"][0]["state"] == "cancelled"
