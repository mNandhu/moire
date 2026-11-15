"""Read latency while the backend writes (items 5-7).

Against a running serve.py backend: an open-loop reader at --rps
(feed first page, /tags all sources, /tags/browse, image detail, thumbnail,
round robin), a /health ping every 50 ms (event-loop lag), and /__bench/stats
every 250 ms (tag view builds, invalidations, RSS, WAL size).

phases: idle (--idle s) -> action -> until the action ends -> tail (--tail s)

usage: concurrency.py <run_name> --port P --action {none,scan,reproject,reproject-noop,delete}
        [--path DIR] (scan: folder to add as a new library)
        [--lib ID]   (delete: library id to remove)
"""

import argparse
import asyncio
import json
import random
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--action", required=True)
ap.add_argument("--path")
ap.add_argument("--lib")
ap.add_argument("--rps", type=float, default=10)
ap.add_argument("--idle", type=float, default=15)
ap.add_argument("--tail", type=float, default=8)
ap.add_argument("--max", type=float, default=900)
a = ap.parse_args()
B = f"http://127.0.0.1:{a.port}"
A = f"{B}/api/v1"


async def main():
    lim = httpx.Limits(max_connections=64, max_keepalive_connections=64)
    async with httpx.AsyncClient(
        timeout=60, limits=lim, headers={"Accept-Encoding": "identity"}
    ) as cli:
        feed = (await cli.get(f"{A}/images", params={"limit": 200})).json()
        ids = [r["_id"] for r in feed][:200]
        rnd = random.Random(1)
        eps = [
            ("feed", lambda: f"{A}/images?limit=200"),
            ("tags", lambda: f"{A}/tags?include_manual=true&include_prompt=true"),
            ("browse", lambda: f"{A}/tags/browse"),
            ("detail", lambda: f"{A}/images/{rnd.choice(ids)}"),
            ("thumb", lambda: f"{A}/images/{rnd.choice(ids)}/thumb"),
        ]
        reqs, pings, stats, events = [], [], [], []
        phase = ["idle"]
        stop = asyncio.Event()

        async def one(kind, url):
            t0 = time.perf_counter()
            try:
                r = await cli.get(url)
                code = r.status_code
                body = r.text[:200] if code >= 500 else ""
            except Exception as e:  # noqa: BLE001
                code, body = -1, repr(e)[:200]
            reqs.append(
                (t0 - T0, kind, (time.perf_counter() - t0) * 1000, code, phase[0], body)
            )

        async def reader():
            i = 0
            tasks = set()
            nxt = time.perf_counter()
            while not stop.is_set():
                kind, f = eps[i % len(eps)]
                i += 1
                tk = asyncio.create_task(one(kind, f()))
                tasks.add(tk)
                tk.add_done_callback(tasks.discard)
                nxt += 1 / a.rps
                await asyncio.sleep(max(0, nxt - time.perf_counter()))
            await asyncio.gather(*tasks)

        async def pinger():
            while not stop.is_set():
                t0 = time.perf_counter()
                try:
                    await cli.get(f"{B}/health")
                    pings.append((t0 - T0, (time.perf_counter() - t0) * 1000, phase[0]))
                except Exception:
                    pings.append((t0 - T0, -1, phase[0]))
                await asyncio.sleep(max(0, 0.05 - (time.perf_counter() - t0)))

        async def statter():
            while not stop.is_set():
                try:
                    s = (await cli.get(f"{B}/__bench/stats")).json()
                    s["t"] = time.perf_counter() - T0
                    s["phase"] = phase[0]
                    stats.append(s)
                except Exception:
                    pass
                await asyncio.sleep(0.25)

        async def action_done() -> bool:
            if a.action in ("reproject", "reproject-noop"):
                s = (await cli.get(f"{B}/__bench/stats")).json()
                return s.get("last_reproject") not in (None, rep_before[0])
            act = (await cli.get(f"{A}/activity")).json()
            items = act.get("items", act) if isinstance(act, dict) else act
            libs = (await cli.get(f"{A}/libraries")).json()
            busy = any(lb.get("scanning") or lb.get("deleting") for lb in libs)
            kinds = (
                {it.get("kind") for it in items} if isinstance(items, list) else set()
            )
            return not busy and not (kinds & {"scan", "reproject", "delete"})

        rep_before = [
            (await cli.get(f"{B}/__bench/stats")).json().get("last_reproject")
        ]
        T0 = time.perf_counter()
        bg = [asyncio.create_task(c()) for c in (reader, pinger, statter)]
        await asyncio.sleep(a.idle)
        phase[0] = "action"
        ta = time.perf_counter()
        events.append(("action_start", ta - T0))
        if a.action == "scan":
            r = await cli.post(
                f"{A}/libraries", json={"path": a.path, "name": "benchscan"}
            )
            events.append(("add_library", r.status_code, r.json()))
        elif a.action == "reproject":
            await cli.post(f"{B}/__bench/reproject", params={"force": 1})
        elif a.action == "reproject-noop":
            await cli.post(f"{B}/__bench/reproject", params={"force": 0})
        elif a.action == "delete":
            r = await cli.delete(f"{A}/libraries/{a.lib}")
            events.append(("delete_returned", time.perf_counter() - T0, r.status_code))
        if a.action != "none":
            await asyncio.sleep(1.0)
            while not await action_done() and time.perf_counter() - ta < a.max:
                await asyncio.sleep(0.25)
        events.append(("action_end", time.perf_counter() - T0))
        action_s = time.perf_counter() - ta
        phase[0] = "tail"
        await asyncio.sleep(a.tail)
        stop.set()
        await asyncio.gather(*bg)

    def pct(xs, q):
        xs = sorted(xs)
        return round(xs[min(len(xs) - 1, int(q * len(xs)))], 1) if xs else None

    summ = {}
    for ph in ("idle", "action", "tail"):
        for kind in [e[0] for e in eps] + ["ALL"]:
            lat = [r[2] for r in reqs if r[4] == ph and (kind == "ALL" or r[1] == kind)]
            if not lat:
                continue
            summ[f"{ph}/{kind}"] = {
                "n": len(lat),
                "p50": pct(lat, 0.5),
                "p95": pct(lat, 0.95),
                "max": round(max(lat), 1),
                "errors": sum(
                    1
                    for r in reqs
                    if r[4] == ph and (kind == "ALL" or r[1] == kind) and r[3] != 200
                ),
            }
        pl = [p[1] for p in pings if p[2] == ph and p[1] >= 0]
        if pl:
            summ[f"{ph}/health"] = {
                "n": len(pl),
                "p50": pct(pl, 0.5),
                "p95": pct(pl, 0.95),
                "max": round(max(pl), 1),
                "over_100ms": sum(1 for x in pl if x > 100),
                "over_500ms": sum(1 for x in pl if x > 500),
            }
    act_stats = [s for s in stats if s["phase"] == "action"] or stats
    first, last = stats[0], stats[-1]
    res = {
        "name": a.name,
        "action": a.action,
        "action_s": round(action_s, 2),
        "events": events,
        "load": benv.load_avg(),
        "summary": summ,
        "errors": [r for r in reqs if r[3] != 200][:20],
        "wal_MB_max": max(s["wal_MB"] for s in stats),
        "wal_MB_end": last["wal_MB"],
        "rss_MB": {
            "idle_start": first["rss_MB"],
            "action_max": max(s["rss_MB"] for s in act_stats),
            "end": last["rss_MB"],
            "hwm_end": last["hwm_MB"],
        },
        "invalidations_during": last["invalidate"] - first["invalidate"],
        "soft_invalidations_during": last["invalidate_soft"] - first["invalidate_soft"],
        "view_builds_during": {
            k: v - first["builds"].get(k, 0) for k, v in last["builds"].items()
        },
        "view_build_s_during": round(last["build_s"] - first["build_s"], 2),
        "server_cpu_s": round(last["cpu_s"] - first["cpu_s"], 1),
        "last_reproject": last.get("last_reproject"),
    }
    out = benv.BENCH / "results" / f"{a.name}.json"
    out.write_text(json.dumps(res, indent=1, default=str))
    (benv.BENCH / "results" / f"{a.name}.raw.json").write_text(
        json.dumps({"reqs": reqs, "pings": pings, "stats": stats}, default=str)
    )
    print(
        json.dumps(
            {k: v for k, v in res.items() if k != "errors"}, indent=1, default=str
        )
    )
    if res["errors"]:
        print("ERRORS:", res["errors"][:5])


asyncio.run(main())
