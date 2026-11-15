"""Watched-folder incremental ingest latency (item 3).

Against a running serve.py backend (lifespan on, WATCH_ENABLED_DEFAULT=true):
adds <watchdir> as a library (empty, so its scan is instant and its watcher
starts), then for each N copies N new PNGs into it (plain copy: new mtimes,
newest first in the feed) and polls the library feed every 100 ms until all N
are listed, and again until all N carry derived gen (prompt tags).

usage: watch_ingest.py <run_name> --port P --watchdir DIR --src DIR [--ns 1,10,100]
       [--burst]  (copy all N at once; default) | [--spaced S] (S seconds apart)
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import sqlite3

import httpx

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--watchdir", required=True)
ap.add_argument("--src", required=True)
ap.add_argument("--ns", default="1,10,100")
ap.add_argument("--spaced", type=float, default=0.0)
ap.add_argument(
    "--db", required=True, help="the server DB, read-only, to see derived gen"
)
a = ap.parse_args()
A = f"http://127.0.0.1:{a.port}/api/v1"
B = f"http://127.0.0.1:{a.port}"
wd = Path(a.watchdir).resolve()
assert "bench/scan" in str(wd)
wd.mkdir(parents=True, exist_ok=True)
src = sorted(Path(a.src).glob("*.png"))
cli = httpx.Client(timeout=60, headers={"Accept-Encoding": "identity"})

r = cli.post(f"{A}/libraries", json={"path": str(wd), "name": "watchbench"})
lib = r.json()["_id"]
print("library", lib, r.status_code)
# wait for the (empty or not) first scan to finish
while any(
    lb["scanning"] for lb in cli.get(f"{A}/libraries").json() if lb["_id"] == lib
):
    time.sleep(0.1)
time.sleep(2.0)  # let the watcher child start its inotify watch


ro = sqlite3.connect(f"file:{Path(a.db).resolve()}?mode=ro", uri=True)


def listed() -> dict[str, dict]:
    rows = cli.get(f"{A}/images", params={"limit": 1000, "library_id": lib}).json()
    gen = {
        r[0]
        for r in ro.execute(
            "select _id from images where library_id=? and json_type(gen)='object'",
            (lib,),
        )
    }
    return {r["_id"]: {**r, "gen": r["_id"] in gen} for r in rows}


results = []
used = 0
for n in [int(x) for x in a.ns.split(",")]:
    batch = src[used : used + n]
    used += n
    want = {f"{lib}:n{n}_{p.name}" for p in batch}
    s0 = cli.get(f"{B}/__bench/stats").json()
    t0 = time.perf_counter()
    put_at = {}
    for p in batch:
        dst = wd / f"n{n}_{p.name}"
        shutil.copyfile(p, dst)  # data only: new mtime
        put_at[f"{lib}:{dst.name}"] = time.perf_counter() - t0
        if a.spaced:
            time.sleep(a.spaced)
    t_copied = time.perf_counter() - t0
    seen: dict[str, float] = {}
    derived: dict[str, float] = {}
    deadline = t0 + 60 + n * 5
    while (len(seen) < n or len(derived) < n) and time.perf_counter() < deadline:
        now = time.perf_counter() - t0
        for iid, row in listed().items():
            if iid in want:
                seen.setdefault(iid, now)
                if row["gen"]:
                    derived.setdefault(iid, now)
        time.sleep(0.1)
    s1 = cli.get(f"{B}/__bench/stats").json()
    lat = sorted(seen[i] - put_at[i] for i in seen)
    first_seen = sorted(seen.values())
    res = {
        "n": n,
        "copy_s": round(t_copied, 2),
        "all_listed_s": round(max(seen.values()), 2) if len(seen) == n else None,
        "all_derived_s": round(max(derived.values()), 2) if len(derived) == n else None,
        "listed": len(seen),
        "derived": len(derived),
        "first_listed_s": round(first_seen[0], 2) if first_seen else None,
        "per_image_latency_p50_s": round(lat[len(lat) // 2], 2) if lat else None,
        "per_image_latency_max_s": round(lat[-1], 2) if lat else None,
        "steady_rate_img_per_s": round((n - 1) / (first_seen[-1] - first_seen[0]), 2)
        if n > 1 and len(first_seen) == n and first_seen[-1] > first_seen[0]
        else None,
        "invalidations": s1["invalidate"] - s0["invalidate"],
        "view_builds": {k: v - s0["builds"].get(k, 0) for k, v in s1["builds"].items()},
        "server_cpu_s": round(s1["cpu_s"] - s0["cpu_s"], 2),
        "rss_MB": s1["rss_MB"],
        "listed_times": [round(x, 2) for x in first_seen],
        "load": benv.load_avg(),
    }
    results.append(res)
    print(json.dumps({k: v for k, v in res.items() if k != "listed_times"}))
    time.sleep(3)

(benv.BENCH / "results" / f"{a.name}.json").write_text(json.dumps(results, indent=1))
