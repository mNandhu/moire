"""Item 5: auto-tag latency, new image -> AI tags stored.

Needs a server (serve.py, lifespan on) on a DB copy with every existing image
marked has_ai_tags=1 (so turning auto_tag on queues nothing) and an empty
ingest folder under bench/ai/work. Sources are copied from --src (originals,
read-only) into the ingest folder; the commit log (/__bench/ai) gives when each
was tagged.

  scan path:    files placed first, then POST /libraries (full scan -> scan end
                nudge -> 3 s delay -> job)
  watch path:   library exists (watched), a file is copied in (2 s watcher poll
                -> quiet window -> ingest -> nudge -> 3 s delay -> job)
Each with the model warm (loaded) and cold (POST /ai/model/unload first).

usage: autotag.py <name> --port P --ingest DIR --src-db DB
"""

import argparse
import asyncio
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--ingest", required=True)
ap.add_argument("--src-db", required=True)
a = ap.parse_args()
B = f"http://127.0.0.1:{a.port}"
A = f"{B}/api/v1"
ING = Path(a.ingest).resolve()
benv.guard(ING)

src = [
    r[0]
    for r in sqlite3.connect(f"file:{a.src_db}?mode=ro", uri=True).execute(
        "select path from images where lower(path) like '%.png' order by mtime desc limit 400 offset 2000"
    )
]
src_i = [0]


def place(sub: Path, n: int) -> list[str]:
    """Copy n originals into sub with fresh names; returns their file names."""
    sub.mkdir(parents=True, exist_ok=True)
    names = []
    for _ in range(n):
        s = src[src_i[0]]
        src_i[0] += 1
        name = f"auto_{src_i[0]:04d}.png"
        tmp = sub / (name + ".part")
        shutil.copyfile(s, tmp)
        os.replace(tmp, sub / name)
        names.append(name)
    return names


async def commits(cli):
    return (await cli.get(f"{B}/__bench/ai")).json()


async def wait_tagged(cli, names, t0, timeout=180):
    """Wall time from t0 to each name's AI-tag commit."""
    want = set(names)
    got = {}
    while time.time() - t0 < timeout and len(got) < len(want):
        ai = await commits(cli)
        for tc, _pairs, image_id in ai["commits"]:
            base = image_id.split(":", 1)[-1].replace("\\", "/").rsplit("/", 1)[-1]
            if base in want and base not in got:
                got[base] = round(tc - t0, 2)
        await asyncio.sleep(0.1)
    return got


async def main():
    out = {"name": a.name, "load": benv.load_avg(), "runs": []}
    async with httpx.AsyncClient(timeout=120) as cli:
        r = await cli.post(f"{A}/ai/settings", json={"auto_tag": True})
        out["auto_tag_on"] = r.json().get("auto_tag")
        await asyncio.sleep(5)
        out["queued_at_switch_on"] = [
            j.get("total") for j in (await cli.get(f"{A}/ai/jobs")).json()
        ]

        async def unload():
            await cli.post(f"{A}/ai/model/unload")
            await asyncio.sleep(1)

        # ---- scan path: new library over a folder with files already in it
        for temp in ("cold", "warm"):
            if temp == "cold":
                await unload()
            else:
                await cli.post(f"{A}/ai/model/load")
                while not (await cli.get(f"{A}/ai/status")).json()["model"]["loaded"]:
                    await asyncio.sleep(0.2)
            await cli.post(f"{B}/__bench/reset")
            sub = ING / f"scan_{temp}"
            names = place(sub, 10)
            t0 = time.time()
            r = await cli.post(
                f"{A}/libraries", json={"path": str(sub), "name": f"auto-{temp}"}
            )
            lib = r.json()
            scan_end = None
            while time.time() - t0 < 120:
                libs = (await cli.get(f"{A}/libraries")).json()
                me = next((x for x in libs if x.get("_id") == lib.get("_id")), None)
                if (
                    me
                    and not me.get("scanning")
                    and (me.get("image_count") or me.get("count") or 0) >= 0
                    and time.time() - t0 > 0.5
                ):
                    scan_end = round(time.time() - t0, 2)
                    break
                await asyncio.sleep(0.05)
            got = await wait_tagged(cli, names, t0)
            ai = await commits(cli)
            out["runs"].append(
                {
                    "path": "scan",
                    "model": temp,
                    "files": len(names),
                    "scan_end_s": scan_end,
                    "first_tagged_s": min(got.values()) if got else None,
                    "last_tagged_s": max(got.values()) if got else None,
                    "tagged": len(got),
                    "model_load_ms": [round(d * 1000) for _, d in ai["model_load"]],
                }
            )
            print(out["runs"][-1], flush=True)

        # ---- watch path: copy into the (watched) warm library folder
        sub = ING / "scan_warm"
        for temp, n in (("warm", 1), ("warm", 5), ("cold", 1)):
            if temp == "cold":
                await unload()
            await cli.post(f"{B}/__bench/reset")
            await asyncio.sleep(1)
            t0 = time.time()
            names = place(sub, n)
            got = await wait_tagged(cli, names, t0)
            ai = await commits(cli)
            out["runs"].append(
                {
                    "path": "watch",
                    "model": temp,
                    "files": n,
                    "first_tagged_s": min(got.values()) if got else None,
                    "last_tagged_s": max(got.values()) if got else None,
                    "tagged": len(got),
                    "model_load_ms": [round(d * 1000) for _, d in ai["model_load"]],
                }
            )
            print(out["runs"][-1], flush=True)
            await asyncio.sleep(2)
    (benv.BENCH / "results" / f"{a.name}.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


asyncio.run(main())
