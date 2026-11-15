"""Item 1: idle_unload. Set idle_unload_s=10, tag 10 images, watch the model
unload and the GPU memory, then tag 10 more (reload) while pinging /health.

usage: idle_unload.py <name> --port P
"""

import argparse
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--port", type=int, required=True)
a = ap.parse_args()
B = f"http://127.0.0.1:{a.port}"
A = f"{B}/api/v1"


def gpu_mem():
    return int(
        subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]
        ).split()[0]
    )


async def main():
    out = {"name": a.name, "events": []}
    pings = []
    stop = asyncio.Event()
    async with httpx.AsyncClient(timeout=60) as cli:

        async def pinger():
            while not stop.is_set():
                t0 = time.perf_counter()
                await cli.get(f"{B}/health")
                pings.append((time.time(), (time.perf_counter() - t0) * 1000))
                await asyncio.sleep(0.05)

        pt = asyncio.create_task(pinger())
        out["gpu_MiB_before"] = gpu_mem()
        await cli.post(f"{A}/ai/settings", json={"idle_unload_s": 10})

        async def job(n):
            t0 = time.time()
            j = (await cli.post(f"{A}/ai/tag-untagged", json={"limit": n})).json()
            while True:
                s = (await cli.get(f"{A}/ai/jobs/{j['job_id']}")).json()
                if s["status"] in ("done", "error", "cancelled"):
                    break
                await asyncio.sleep(0.05)
            mx = max((p for t, p in pings if t >= t0), default=None)
            return {
                "wall_s": round(time.time() - t0, 2),
                "model_phase_s": round(s["started_at"] - s["created_at"], 2),
                "rate": s.get("rate"),
                "health_max_ms": round(mx, 1),
                "gpu_MiB_after": gpu_mem(),
            }

        out["job1_cold"] = await job(10)
        t_end = time.time()
        series = []
        unloaded_at = None
        while time.time() - t_end < 40:
            st = (await cli.get(f"{A}/ai/status")).json()["model"]
            series.append((round(time.time() - t_end, 1), st["loaded"], gpu_mem()))
            if not st["loaded"] and unloaded_at is None:
                unloaded_at = round(time.time() - t_end, 1)
            await asyncio.sleep(1)
        out["unloaded_after_s"] = unloaded_at
        out["series"] = series[::3]
        out["job2_reload"] = await job(10)
        await asyncio.sleep(1)
        out["job3_warm"] = await job(10)
        await cli.post(f"{A}/ai/settings", json={"idle_unload_s": 300})
        stop.set()
        await pt
    (benv.BENCH / "results" / f"{a.name}.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


asyncio.run(main())
