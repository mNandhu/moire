import asyncio, os, sys, itertools
from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import JSONResponse
from PIL import Image

OUT = os.environ.get('FAKE_COMFY_OUT', 'out')
app = FastAPI()
hist, pending, running = {}, [], []
n = itertools.count(1)

@app.get("/system_stats")
def stats(): return {"system": {"comfyui_version": "fake"}, "devices": []}

@app.get("/object_info/{cls}")
def info(cls: str):
    if cls == "CheckpointLoaderSimple":
        return {cls: {"input": {"required": {"ckpt_name": [["illustriousXL_v01.safetensors"]]}}}}
    return {cls: {"input": {"required": {"lora_name": [["styles/flat_color_xl.safetensors"]]}}}}

@app.get("/embeddings")
def emb(): return ["easynegative"]

async def run(pid, graph):
    await asyncio.sleep(0.5)
    pending.remove(pid); running.append(pid)
    await asyncio.sleep(0.5)
    lat = next(v for v in graph.values() if v["class_type"] == "EmptyLatentImage")["inputs"]
    save = next(v for v in graph.values() if v["class_type"] == "SaveImage")["inputs"]["filename_prefix"]
    sub, _, stem = save.rpartition("/")
    os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    files = []
    for i in range(int(lat["batch_size"])):
        fn = f"{stem}_{pid}_{i:05}_.png"
        Image.new("RGB", (lat["width"] // 8, lat["height"] // 8), (40 * i % 255, 90, 160)).save(os.path.join(OUT, sub, fn))
        files.append({"filename": fn, "subfolder": sub, "type": "output"})
    running.remove(pid)
    hist[pid] = {"outputs": {"9": {"images": files}}, "status": {"status_str": "success", "completed": True, "messages": []}}

@app.post("/prompt")
async def prompt(req: Request):
    body = await req.json()
    pid = f"p{next(n)}"
    pending.append(pid)
    asyncio.create_task(run(pid, body["prompt"]))
    return {"prompt_id": pid, "number": 1, "node_errors": {}}

@app.get("/history/{pid}")
def history(pid: str): return {pid: hist[pid]} if pid in hist else {}

@app.get("/queue")
def queue(): return {"queue_running": [[0, p, {}, {}, []] for p in running], "queue_pending": [[0, p, {}, {}, []] for p in pending]}

@app.post("/interrupt")
def interrupt(): return {}

@app.websocket("/ws")
async def ws(w: WebSocket):
    await w.accept()
    while True:
        await asyncio.sleep(1)
        await w.send_json({"type": "status", "data": {"status": {"exec_info": {"queue_remaining": len(pending) + len(running)}}}})
