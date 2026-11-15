"""Item 1: standalone tagger stages, GPU vs CPU EP, batch sizes, model load.

usage: tagger_bench.py <db> <n_images> <providers: cuda|cpu> [--batches 1,2,4,8] [--evict]
Uses the app's own decode_image / prepare_image / select_tags / _make_session.
Writes results/tagger-<providers>.json.
"""

import argparse
import json
import sqlite3
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("db")
ap.add_argument("n", type=int)
ap.add_argument("prov")
ap.add_argument("--batches", default="1")
ap.add_argument("--evict", action="store_true")
ap.add_argument("--offset", type=int, default=0)
a = ap.parse_args()
benv.setup(a.db, benv.BENCH / "db" / "thumbs")

import numpy as np  # noqa: E402

t_imp = time.perf_counter()
from moire.services.ai import tagger as tg  # noqa: E402
import onnxruntime as ort  # noqa: E402

t_imp = time.perf_counter() - t_imp

M = benv.BENCH / "models"
onnx = str((M / "SmilingWolf_wd-vit-tagger-v3.onnx").resolve())
csv = str((M / "SmilingWolf_wd-vit-tagger-v3.csv").resolve())

db = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
paths = [
    r[0]
    for r in db.execute(
        "select path from images where has_ai_tags=0 and quarantined=0 "
        "order by mtime desc, _id desc limit ? offset ?",
        (a.n, a.offset),
    )
]
if a.evict:
    print("evicted", benv.evict(paths + [onnx]))


def pct(xs, q):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(q * len(xs)))], 2)


def summ(xs):
    return {
        "mean": round(statistics.mean(xs), 2),
        "p50": pct(xs, 0.5),
        "p95": pct(xs, 0.95),
        "n": len(xs),
    }


res = {
    "providers": a.prov,
    "n": len(paths),
    "load_avg_start": benv.load_avg(),
    "import_s": round(t_imp, 2),
}

# ---- model load
t0 = time.perf_counter()
labels = tg._load_labels_from_csv(csv)
res["labels_ms"] = round((time.perf_counter() - t0) * 1000, 1)


def make(prov):
    if prov == "cpu":
        opts = ort.SessionOptions()
        opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
        opts.add_session_config_entry("session.inter_op.allow_spinning", "0")
        return ort.InferenceSession(
            onnx, sess_options=opts, providers=["CPUExecutionProvider"]
        )
    return tg._make_session(ort, onnx)


loads = []
for i in range(2):
    t0 = time.perf_counter()
    sess = make(a.prov)
    loads.append(round(time.perf_counter() - t0, 2))
    if i == 0:
        del sess
res["session_load_s"] = {"first_in_process": loads[0], "second": loads[1]}
res["session_providers"] = sess.get_providers()
inp = sess.get_inputs()[0]
res["input_shape"] = [str(d) for d in inp.shape]
size = int(inp.shape[1])
out_name = sess.get_outputs()[0].name

# warm-up run (first CUDA run builds kernels)
t0 = time.perf_counter()
sess.run([out_name], {inp.name: np.zeros((1, size, size, 3), np.float32)})
res["first_run_ms"] = round((time.perf_counter() - t0) * 1000, 1)

params = tg.TagParams()
st = {k: [] for k in ("read", "decode", "prepare", "infer", "select", "total")}
tensors = []
sizes = []
for p in paths:
    t0 = time.perf_counter()
    with open(p, "rb") as f:
        b = f.read()
    t1 = time.perf_counter()
    img = tg.decode_image(b)
    t2 = time.perf_counter()
    x = tg.prepare_image(img, size)
    t3 = time.perf_counter()
    preds = sess.run([out_name], {inp.name: x})[0][0]
    t4 = time.perf_counter()
    tg.select_tags(labels, preds, params)
    t5 = time.perf_counter()
    for k, d in zip(
        ("read", "decode", "prepare", "infer", "select", "total"),
        (t1 - t0, t2 - t1, t3 - t2, t4 - t3, t5 - t4, t5 - t0),
    ):
        st[k].append(d * 1000)
    sizes.append((img.size, len(b)))
    tensors.append(x)
res["stages_ms"] = {k: summ(v) for k, v in st.items()}
res["mean_px"] = round(statistics.mean(w * h for (w, h), _ in sizes) / 1e6, 2)
res["mean_MB"] = round(statistics.mean(n for _, n in sizes) / 1e6, 2)
res["seq_img_s"] = round(len(paths) / (sum(st["total"]) / 1000), 2)
res["infer_only_img_s"] = round(len(paths) / (sum(st["infer"]) / 1000), 2)

# ---- inference again, tensors in memory (pure inference throughput)
batches = {}
for bs in [int(x) for x in a.batches.split(",")]:
    xs = tensors[: (len(tensors) // bs) * bs]
    try:
        sess.run([out_name], {inp.name: np.concatenate(xs[:bs])})  # warm this shape
        t0 = time.perf_counter()
        for i in range(0, len(xs), bs):
            sess.run([out_name], {inp.name: np.concatenate(xs[i : i + bs])})
        dt = time.perf_counter() - t0
        batches[bs] = {
            "ms_per_img": round(dt * 1000 / len(xs), 1),
            "img_s": round(len(xs) / dt, 2),
        }
    except Exception as e:  # noqa: BLE001
        batches[bs] = {"error": str(e)[:200]}
res["batch"] = batches

# ---- CPU-side prep throughput with a thread pool (can the CPU feed the GPU?)
from concurrent.futures import ThreadPoolExecutor  # noqa: E402


def prep(p):
    with open(p, "rb") as f:
        img = tg.decode_image(f.read())
    return tg.prepare_image(img, size)


pool = {}
for w in (1, 2, 4):
    with ThreadPoolExecutor(w) as ex:
        t0 = time.perf_counter()
        list(ex.map(prep, paths))
        dt = time.perf_counter() - t0
    pool[w] = round(len(paths) / dt, 2)
res["prep_img_s_by_threads"] = pool
res["load_avg_end"] = benv.load_avg()
res["rss_MB"] = benv.proc_mem()
out = benv.BENCH / "results" / f"tagger-{a.prov}{'-evict' if a.evict else ''}.json"
out.write_text(json.dumps(res, indent=1))
print(json.dumps(res, indent=1))
