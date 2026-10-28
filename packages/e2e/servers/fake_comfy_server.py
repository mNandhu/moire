import asyncio
import os
import itertools
import time
from fastapi import FastAPI, WebSocket, Request
from PIL import Image

OUT = os.environ.get("FAKE_COMFY_OUT", "out")
app = FastAPI()
hist, pending, running = {}, [], []
# The loop only holds tasks weakly: keep each run alive until it finishes.
tasks: set[asyncio.Task] = set()
n = itertools.count(1)
# Seconds each prompt runs; POST /fake/run?seconds=N changes it.
RUN = {"seconds": float(os.environ.get("FAKE_COMFY_RUN", "0.5"))}


@app.post("/fake/run")
def set_run(seconds: float):
    RUN["seconds"] = seconds
    return RUN


@app.get("/system_stats")
def stats():
    return {"system": {"comfyui_version": "fake"}, "devices": []}


@app.get("/object_info/{cls}")
def info(cls: str):
    if cls == "CheckpointLoaderSimple":
        return {
            cls: {
                "input": {
                    "required": {"ckpt_name": [["illustriousXL_v01.safetensors"]]}
                }
            }
        }
    return {
        cls: {
            "input": {"required": {"lora_name": [["styles/flat_color_xl.safetensors"]]}}
        }
    }


@app.get("/embeddings")
def emb():
    return ["easynegative"]


async def run(pid, graph):
    await asyncio.sleep(0.5)
    pending.remove(pid)
    running.append(pid)
    began = time.time() * 1000
    await asyncio.sleep(RUN["seconds"])
    # Any graph: the first node with a literal size, else a small square; any saver.
    lat = next(
        (
            v["inputs"]
            for v in graph.values()
            if isinstance(v["inputs"].get("width"), int)
        ),
        {"width": 512, "height": 512, "batch_size": 1},
    )
    lat = {
        **lat,
        "batch_size": lat.get("batch_size")
        if isinstance(lat.get("batch_size"), int)
        else 1,
    }
    saver = next(
        v
        for v in graph.values()
        if "save" in v["class_type"].lower()
        and "preview" not in v["class_type"].lower()
    )
    save = saver["inputs"].get("filename_prefix")
    save = save if isinstance(save, str) else "fake/out"
    sub, _, stem = save.rpartition("/")
    os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    files = []
    for i in range(int(lat["batch_size"])):
        fn = f"{stem}_{pid}_{i:05}_.png"
        Image.new(
            "RGB", (lat["width"] // 8, lat["height"] // 8), (40 * i % 255, 90, 160)
        ).save(os.path.join(OUT, sub, fn))
        files.append({"filename": fn, "subfolder": sub, "type": "output"})
    running.remove(pid)
    hist[pid] = {
        "outputs": {"9": {"images": files}},
        "status": {
            "status_str": "success",
            "completed": True,
            "messages": [
                ["execution_start", {"prompt_id": pid, "timestamp": began}],
                [
                    "execution_success",
                    {"prompt_id": pid, "timestamp": time.time() * 1000},
                ],
            ],
        },
    }


@app.post("/prompt")
async def prompt(req: Request):
    body = await req.json()
    pid = f"p{next(n)}"
    pending.append(pid)
    task = asyncio.create_task(run(pid, body["prompt"]))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {"prompt_id": pid, "number": 1, "node_errors": {}}


@app.get("/history/{pid}")
def history(pid: str):
    return {pid: hist[pid]} if pid in hist else {}


@app.get("/queue")
def queue():
    return {
        "queue_running": [[0, p, {}, {}, []] for p in running],
        "queue_pending": [[0, p, {}, {}, []] for p in pending],
    }


@app.post("/interrupt")
def interrupt():
    return {}


@app.websocket("/ws")
async def ws(w: WebSocket):
    await w.accept()
    while True:
        await asyncio.sleep(1)
        await w.send_json(
            {
                "type": "status",
                "data": {
                    "status": {
                        "exec_info": {"queue_remaining": len(pending) + len(running)}
                    }
                },
            }
        )
