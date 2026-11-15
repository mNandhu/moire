"""Item 6: one image's re-tag through POST /ai/tag (retag=true), as the image
view's "Run AI tagging" does. Latency from POST to the job's done status
(polled every 20 ms), then the cost of the first /tags, /tags/browse and
/tags/characters after it (its writes hard-invalidate every view).

usage: retag.py <name> --port P [--n 5] [--during-bulk N]
  --during-bulk N: first queue a tag-untagged run of N images, wait for it to
  be tagging, then do the re-tags while it runs (the urgent path).
"""

import argparse
import asyncio
import json
import random
import statistics
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--n", type=int, default=5)
ap.add_argument("--during-bulk", type=int)
a = ap.parse_args()
A = f"http://127.0.0.1:{a.port}/api/v1"
VIEWS = [
    ("tags", "/tags"),
    ("tags_all", "/tags?include_manual=true&include_prompt=true"),
    ("browse", "/tags/browse"),
    ("characters", "/tags/characters"),
]


async def timed(cli, url):
    t0 = time.perf_counter()
    r = await cli.get(A + url)
    return round((time.perf_counter() - t0) * 1000, 1), r.status_code


async def main():
    out = {"name": a.name, "load": benv.load_avg(), "trials": []}
    async with httpx.AsyncClient(timeout=120) as cli:
        feed = (await cli.get(f"{A}/images", params={"limit": 200})).json()
        ids = [r["_id"] for r in feed]
        random.Random(7).shuffle(ids)
        # warm views first
        out["views_warm_before"] = {k: (await timed(cli, u))[0] for k, u in VIEWS}
        out["views_warm_again"] = {k: (await timed(cli, u))[0] for k, u in VIEWS}
        bulk = None
        if a.during_bulk:
            bulk = (
                await cli.post(f"{A}/ai/tag-untagged", json={"limit": a.during_bulk})
            ).json()["job_id"]
            while (await cli.get(f"{A}/ai/jobs/{bulk}")).json().get(
                "phase"
            ) != "tagging":
                await asyncio.sleep(0.1)
            await asyncio.sleep(3)
        for i in range(a.n):
            image_id = ids[i]
            t0 = time.perf_counter()
            r = (
                await cli.post(f"{A}/ai/tag", json={"ids": [image_id], "retag": True})
            ).json()
            t_post = time.perf_counter() - t0
            while True:
                j = (await cli.get(f"{A}/ai/jobs/{r['job_id']}")).json()
                if j["status"] in ("done", "error", "cancelled"):
                    break
                await asyncio.sleep(0.02)
            t_done = time.perf_counter() - t0
            views = {k: (await timed(cli, u))[0] for k, u in VIEWS}
            out["trials"].append(
                {
                    "post_ms": round(t_post * 1000, 1),
                    "done_ms": round(t_done * 1000, 1),
                    "status": j["status"],
                    "phase_model_s": round(j["started_at"] - j["created_at"], 2)
                    if j.get("started_at")
                    else None,
                    "views_after_ms": views,
                }
            )
            await asyncio.sleep(1)
        if bulk:
            jb = (await cli.get(f"{A}/ai/jobs/{bulk}")).json()
            out["bulk"] = {k: jb.get(k) for k in ("status", "done", "total", "rate")}
            await cli.post(f"{A}/ai/jobs/{bulk}/cancel")
    d = [t["done_ms"] for t in out["trials"]]
    out["done_ms"] = {
        "first": d[0],
        "rest_mean": round(statistics.mean(d[1:]), 1) if len(d) > 1 else None,
        "rest_max": max(d[1:]) if len(d) > 1 else None,
    }
    (benv.BENCH / "results" / f"{a.name}.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


asyncio.run(main())
