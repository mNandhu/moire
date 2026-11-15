"""Reprojection (prompt-tag extraction) timings, in-process, on a DB copy.

usage: reproject_bench.py <run_name> --db DB --mode {noop,force,flip,flipback}

noop     reproject_all() with nothing changed (S3c "nothing changed": 17.6 -> 5.1 s)
force    reproject_all(force=True)            (what migrations run)
flip     toggle the ai.prompt_positive_only switch, then reproject_all()
         (a real settings change: S3c "after a settings flip" 18.2 -> 12.1 s)

Writes results/<run_name>.json.
"""

import argparse
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--db", required=True)
ap.add_argument("--mode", required=True, choices=["noop", "force", "flip"])
a = ap.parse_args()
db = Path(a.db).resolve()
benv.setup(db, db.parent / "thumbs-unused")

import sqlalchemy as sa  # noqa: E402

from moire.database.db import sync_conn, sync_tx  # noqa: E402
from moire.services.metadata import gen_metadata, reproject  # noqa: E402
from moire.services.tags import image_tags  # noqa: E402
from moire.services.tags import index as tag_index  # noqa: E402

stages: dict[str, list[float]] = {}


def wrap(owner, attr, name):
    orig = getattr(owner, attr)

    def w(*args, **kw):
        w0 = time.perf_counter()
        try:
            return orig(*args, **kw)
        finally:
            s = stages.setdefault(name, [0, 0.0])
            s[0] += 1
            s[1] += time.perf_counter() - w0

    setattr(owner, attr, w)


wrap(gen_metadata, "derive", "derive")
wrap(reproject, "_flush_batch", "flush batch (tx)")
wrap(reproject, "_write_gens", "  write gens (in flush)")
wrap(image_tags, "replace_prompt_many_sync", "  replace_prompt_many (in flush)")
wrap(reproject, "_load_rulesets", "load rulesets")
inv = [0]
_oi = tag_index.invalidate


def ci():
    inv[0] += 1
    _oi()


reproject.tag_index.invalidate = ci

if a.mode == "flip":
    with sync_tx() as conn:
        doc = json.loads(
            conn.execute(
                sa.text("select doc from app_settings where _id='ai'")
            ).scalar()
            or "{}"
        )
        doc["prompt_positive_only"] = not doc.get("prompt_positive_only", True)
        conn.execute(
            sa.text("update app_settings set doc=:d where _id='ai'"),
            {"d": json.dumps(doc)},
        )
    print("prompt_positive_only ->", doc["prompt_positive_only"])

with sync_conn() as conn:
    n_raw = conn.execute(sa.text("select count(*) from image_gen_raw")).scalar()
    n_img = conn.execute(sa.text("select count(*) from images")).scalar()
    raw_mb = (
        conn.execute(sa.text("select sum(length(raw)) from image_gen_raw")).scalar()
        / 1e6
    )

samples = []
stop = threading.Event()


def sampler():
    while not stop.is_set():
        samples.append((time.perf_counter(), *benv.proc_mem()))
        stop.wait(0.1)


rss0 = benv.proc_mem()[0]
threading.Thread(target=sampler, daemon=True).start()
load = benv.load_avg()
c0 = benv.proc_cpu()
t0 = time.perf_counter()
n = reproject.reproject_all(force=(a.mode == "force"))
dt = time.perf_counter() - t0
cpu = benv.proc_cpu() - c0
stop.set()
time.sleep(0.15)
rss_after = benv.proc_mem()[0]
peak = max(s[1] for s in samples)
# when did the first flush (first visible write) land
res = {
    "name": a.name,
    "mode": a.mode,
    "images": n_img,
    "raws": n_raw,
    "raw_json_MB": round(raw_mb, 1),
    "derived": n,
    "total_s": round(dt, 2),
    "ms_per_img": round(dt * 1000 / max(1, n_raw), 2),
    "cpu_s": round(cpu, 2),
    "rss_before_MB": rss0,
    "rss_peak_MB": peak,
    "rss_after_MB": rss_after,
    "invalidations": inv[0],
    "load": load,
    "stages": {k: {"calls": v[0], "s": round(v[1], 2)} for k, v in stages.items()},
}
other = dt - sum(v[1] for k, v in stages.items() if not k.startswith(" "))
res["stages"]["load raws + JSON decode + loop (rest)"] = {
    "calls": 1,
    "s": round(other, 2),
}
(benv.BENCH / "results" / f"{a.name}.json").write_text(json.dumps(res, indent=1))
print(json.dumps(res, indent=1))
