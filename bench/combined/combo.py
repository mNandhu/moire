"""Combined-load driver against a running combined/serve.py backend.

Background load for the whole run:
  - open-loop reader at --rps (feed, /tags all sources, /tags/browse, detail,
    thumb, /libraries; round robin), the solo benches' mix
  - frontend polls: activity 1.5 s, ai/status 2 s, ai/coverage 3 s, ai/jobs/{id} 1.5 s
  - /health every 50 ms (event-loop lag); /__bench/stats every 250 ms (state)
  - system CPU (/proc/stat) every 0.5 s; GPU via nvidia-smi 250 ms
phases: idle (--idle s) -> actions -> until every writer is idle -> tail (--tail s)

actions (comma list, all started together unless --seq):
  scan            add --scan-path as a new library (scan + its post-scan reprojection)
  tag:N           POST /ai/tag-untagged limit=N
  faces:N         turn face_detect on (queues avatars) + queue the newest N images
  reproject       forced reproject_all (whole DB) via /__bench/reproject?force=1
  sleep:S         (with --seq) wait S seconds
--seq runs them one after another, each to completion.
--idle-unload S sets ai idle_unload_s first.

Every request / ping is labelled with the writers active when it started
(scan, reproj, ai, faces), and summarised per label.

usage: combo.py <name> --port P --actions scan,tag:600 [--scan-path DIR] [--seq]
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
ap.add_argument("--actions", default="")
ap.add_argument("--scan-path", default=str(benv.BENCH.parent / "scan" / "lib"))
ap.add_argument("--seq", action="store_true")
ap.add_argument("--rps", type=float, default=10)
ap.add_argument("--idle", type=float, default=20)
ap.add_argument("--tail", type=float, default=15)
ap.add_argument("--max", type=float, default=1200)
ap.add_argument("--idle-unload", type=int)
a = ap.parse_args()
B = f"http://127.0.0.1:{a.port}"
A = f"{B}/api/v1"
RES = benv.BENCH / "results"


def pct(xs, q):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(q * len(xs)))], 1) if xs else None


def lat(xs):
    return (
        {
            "n": len(xs),
            "p50": pct(xs, 0.5),
            "p95": pct(xs, 0.95),
            "max": round(max(xs), 1),
            "sum_s": round(sum(xs) / 1000, 2),
        }
        if xs
        else None
    )


def syscpu():
    f = open("/proc/stat").readline().split()[1:]
    v = list(map(int, f))
    idle = v[3] + v[4]
    return sum(v), idle


def label_of(st):
    s = st.get("state", {})
    parts = []
    if s.get("scanning"):
        parts.append("scan")
    if s.get("reproject"):
        parts.append("reproj")
    if s.get("ai_active"):
        parts.append("ai")
    if s.get("faces_pending"):
        parts.append("faces")
    return "+".join(parts) or "quiet"


async def main():
    gpu_csv = RES / f"{a.name}.gpu.csv"
    gpu = subprocess.Popen(
        [
            "nvidia-smi",
            "--query-gpu=timestamp,utilization.gpu,memory.used",
            "--format=csv,noheader,nounits",
            "-lms",
            "250",
        ],
        stdout=open(gpu_csv, "w"),
        stderr=subprocess.DEVNULL,
    )
    lim = httpx.Limits(max_connections=64, max_keepalive_connections=64)
    async with httpx.AsyncClient(
        timeout=120, limits=lim, headers={"Accept-Encoding": "identity"}
    ) as cli:
        if a.idle_unload is not None:
            await cli.post(f"{A}/ai/settings", json={"idle_unload_s": a.idle_unload})
        feed = (await cli.get(f"{A}/images", params={"limit": 200})).json()
        ids = [r["_id"] for r in feed][:200]
        import random

        rnd = random.Random(1)
        eps = [
            ("feed", lambda: f"{A}/images?limit=200"),
            ("tags", lambda: f"{A}/tags?include_manual=true&include_prompt=true"),
            ("browse", lambda: f"{A}/tags/browse"),
            ("detail", lambda: f"{A}/images/{rnd.choice(ids)}"),
            ("thumb", lambda: f"{A}/images/{rnd.choice(ids)}/thumb"),
            ("libraries", lambda: f"{A}/libraries"),
        ]
        job_ids = []
        polls = [
            ("activity", 1.5, lambda: f"{A}/activity"),
            ("ai_status", 2.0, lambda: f"{A}/ai/status"),
            ("ai_coverage", 3.0, lambda: f"{A}/ai/coverage"),
            ("ai_job", 1.5, lambda: f"{A}/ai/jobs/{job_ids[-1]}" if job_ids else None),
        ]
        reqs, pings, stats, cpu, events = [], [], [], [], []
        stop = asyncio.Event()

        async def one(kind, url):
            t0 = time.time()
            try:
                r = await cli.get(url)
                code = r.status_code
            except Exception as e:  # noqa: BLE001
                code = repr(e)[:120]
            reqs.append((t0, kind, (time.time() - t0) * 1000, code))

        async def reader():
            i, tasks, nxt = 0, set(), time.perf_counter()
            while not stop.is_set():
                kind, f = eps[i % len(eps)]
                i += 1
                tk = asyncio.create_task(one(kind, f()))
                tasks.add(tk)
                tk.add_done_callback(tasks.discard)
                nxt += 1 / a.rps
                await asyncio.sleep(max(0, nxt - time.perf_counter()))
            await asyncio.gather(*tasks)

        async def poller(kind, every, f):
            while not stop.is_set():
                t0 = time.perf_counter()
                url = f()
                if url:
                    await one(kind, url)
                await asyncio.sleep(max(0, every - (time.perf_counter() - t0)))

        async def pinger():
            while not stop.is_set():
                t0 = time.time()
                try:
                    await cli.get(f"{B}/health")
                    pings.append((t0, (time.time() - t0) * 1000))
                except Exception:  # noqa: BLE001
                    pings.append((t0, -1))
                await asyncio.sleep(max(0, 0.05 - (time.time() - t0)))

        async def statter():
            while not stop.is_set():
                try:
                    s = (await cli.get(f"{B}/__bench/stats")).json()
                    s["t"] = time.time()
                    stats.append(s)
                except Exception:  # noqa: BLE001
                    pass
                await asyncio.sleep(0.25)

        async def cpusamp():
            prev = syscpu()
            while not stop.is_set():
                await asyncio.sleep(0.5)
                cur = syscpu()
                tot, idl = cur[0] - prev[0], cur[1] - prev[1]
                cpu.append((time.time(), round(12 * (1 - idl / tot), 2) if tot else 0))
                prev = cur

        async def busy():
            try:
                s = (await cli.get(f"{B}/__bench/stats")).json()["state"]
            except httpx.TransportError:
                return True
            return (
                s["scanning"] or s["reproject"] or s["ai_active"] or s["faces_pending"]
            )

        async def wait_quiet(t_start):
            await asyncio.sleep(1.0)
            quiet = 0
            while time.time() - t_start < a.max:
                quiet = 0 if await busy() else quiet + 1
                if quiet >= 4:
                    return
                await asyncio.sleep(0.25)

        async def act(spec):
            kind, _, arg = spec.partition(":")
            t = time.time()
            if kind == "scan":
                r = await cli.post(
                    f"{A}/libraries", json={"path": a.scan_path, "name": "benchscan"}
                )
                events.append((t, "scan", r.status_code))
            elif kind == "tag":
                r = await cli.post(f"{A}/ai/tag-untagged", json={"limit": int(arg)})
                js = r.json()
                job_ids.append(js["job_id"])
                events.append((t, "tag", js))
            elif kind == "faces":
                r1 = await cli.post(f"{A}/ai/settings", json={"face_detect": True})
                r2 = await cli.post(f"{B}/__bench/faces", params={"n": int(arg)})
                events.append((t, "faces", r1.status_code, r2.json()))
            elif kind == "reproject":
                await cli.post(f"{B}/__bench/reproject", params={"force": 1})
                events.append((t, "reproject"))
            elif kind == "sleep":
                events.append((t, "sleep", float(arg)))
                await asyncio.sleep(float(arg))

        T0 = time.time()
        bg = [asyncio.create_task(c()) for c in (reader, pinger, statter, cpusamp)]
        bg += [asyncio.create_task(poller(*p)) for p in polls]
        await asyncio.sleep(a.idle)
        ta = time.time()
        events.append((ta, "action_start"))
        acts = [x for x in a.actions.split(",") if x]
        if a.seq:
            for spec in acts:
                t1 = time.time()
                await act(spec)
                if not spec.startswith("sleep"):
                    await wait_quiet(t1)
                events.append((time.time(), f"done:{spec}", round(time.time() - t1, 2)))
        else:
            for spec in acts:
                await act(spec)
            if acts:
                await wait_quiet(ta)
        te = time.time()
        events.append((te, "action_end"))
        await asyncio.sleep(a.tail)
        stop.set()
        await asyncio.gather(*bg)
        jobs = [(await cli.get(f"{A}/ai/jobs/{j}")).json() for j in job_ids]
        libs = (await cli.get(f"{A}/libraries")).json()
        tx = (await cli.get(f"{B}/__bench/tx")).json()
    gpu.terminate()

    # ---- labelling --------------------------------------------------------------
    import bisect

    st_t = [s["t"] for s in stats]

    def lab(t):
        if t < ta:
            return "idle"
        if t > te:
            return "tail"
        i = bisect.bisect_right(st_t, t) - 1
        return label_of(stats[max(0, i)])

    spans = {}
    for i in range(1, len(stats)):
        lb = lab(stats[i - 1]["t"])
        spans[lb] = spans.get(lb, 0) + stats[i]["t"] - stats[i - 1]["t"]

    summ = {}
    labels = sorted({lab(r[0]) for r in reqs} | {lab(p[0]) for p in pings})
    for lb in labels:
        rr = [r for r in reqs if lab(r[0]) == lb]
        d = {"span_s": round(spans.get(lb, 0), 1)}
        d["ALL"] = lat([r[2] for r in rr])
        d["errors"] = sum(1 for r in rr if r[3] != 200)
        for k in (
            "feed",
            "tags",
            "browse",
            "detail",
            "thumb",
            "libraries",
            "activity",
            "ai_coverage",
        ):
            d[k] = lat([r[2] for r in rr if r[1] == k])
        pl = [p[1] for p in pings if lab(p[0]) == lb and p[1] >= 0]
        if pl:
            d["health"] = {
                **lat(pl),
                "over_100": sum(x > 100 for x in pl),
                "over_500": sum(x > 500 for x in pl),
                "over_1000": sum(x > 1000 for x in pl),
            }
        cl = [c[1] for c in cpu if lab(c[0]) == lb]
        d["sys_cores_busy"] = (
            {"mean": round(sum(cl) / len(cl), 1), "p95": pct(cl, 0.95)} if cl else None
        )
        sl = [s for s in stats if lab(s["t"]) == lb]
        if len(sl) > 1:
            dt = sl[-1]["t"] - sl[0]["t"]
            d["server_cores"] = (
                round((sl[-1]["cpu_s"] - sl[0]["cpu_s"]) / dt, 2) if dt > 0 else None
            )
            d["rss_MB_max"] = max(s["rss_MB"] for s in sl)
            d["wal_MB_max"] = max(s["wal_MB"] for s in sl)
        # tx per window
        for k in ("lock_wait", "lock_hold", "write_stmt", "commit"):
            for side in ("async", "sync"):
                xs = [x[3] for x in tx[k] if x[1] == side and lab(x[0]) == lb]
                if xs:
                    d[f"tx_{k}_{side}"] = lat(xs)
        # AI per window
        ends = [t0 + dt for t0, dt in tx["ai"]["tag_one"] if lab(t0 + dt) == lb]
        if ends and spans.get(lb):
            d["ai_img_per_s"] = round(len(ends) / spans[lb], 2)
            d["ai_write_ms"] = lat(
                [dt * 1000 for t0, dt in tx["ai"]["write"] if lab(t0) == lb]
            )
            d["ai_load_ms"] = lat(
                [dt * 1000 for t0, dt in tx["ai"]["load"] if lab(t0) == lb]
            )
            d["ai_tag_one_ms"] = lat(
                [dt * 1000 for t0, dt in tx["ai"]["tag_one"] if lab(t0) == lb]
            )
        fe = [dt * 1000 for t0, dt in tx["ai"]["face"] if lab(t0) == lb]
        if fe:
            d["face_ms"] = lat(fe)
            d["face_per_s"] = round(len(fe) / spans[lb], 2) if spans.get(lb) else None
        summ[lb] = d

    # GPU per label
    try:
        import datetime as _dt

        g = {}
        for line in open(gpu_csv):
            p = [x.strip() for x in line.split(",")]
            if len(p) < 3:
                continue
            t = _dt.datetime.strptime(p[0], "%Y/%m/%d %H:%M:%S.%f").timestamp()
            g.setdefault(lab(t), []).append((float(p[1]), float(p[2])))
        for lb, xs in g.items():
            summ.setdefault(lb, {})["gpu"] = {
                "util_mean": round(sum(x[0] for x in xs) / len(xs), 1),
                "vram_max_MiB": max(x[1] for x in xs),
            }
    except Exception as e:  # noqa: BLE001
        events.append((time.time(), "gpu_parse_error", repr(e)))

    # timeline of writers
    timeline, prev = [], None
    for s in stats:
        lb = label_of(s)
        if lb != prev:
            timeline.append((round(s["t"] - ta, 2), lb))
            prev = lb
    first, last = stats[0], stats[-1]
    act_stats = [s for s in stats if ta <= s["t"] <= te] or stats
    bench_lib = [lb for lb in libs if lb.get("name") == "benchscan"]
    res = {
        "name": a.name,
        "actions": a.actions,
        "seq": a.seq,
        "action_s": round(te - ta, 2),
        "events": [(round(e[0] - T0, 2), *e[1:]) for e in events],
        "timeline_from_action": timeline,
        "jobs": [
            {
                k: j.get(k)
                for k in ("status", "total", "done", "failed", "rate", "elapsed_s")
            }
            for j in jobs
        ],
        "bench_library": [
            {k: lb.get(k) for k in ("indexed_count", "scan_failed_count", "scan_error")}
            for lb in bench_lib
        ],
        "wal_MB": {"max": max(s["wal_MB"] for s in stats), "end": last["wal_MB"]},
        "rss_MB": {
            "start": first["rss_MB"],
            "action_max": max(s["rss_MB"] for s in act_stats),
            "end": last["rss_MB"],
            "hwm": last["hwm_MB"],
        },
        "invalidations": last["invalidate"] - first["invalidate"],
        "soft_invalidations": last["invalidate_soft"] - first["invalidate_soft"],
        "view_builds": {
            k: v - first["builds"].get(k, 0) for k, v in last["builds"].items()
        },
        "view_build_s": round(last["build_s"] - first["build_s"], 1),
        "server_cpu_s": round(last["cpu_s"] - first["cpu_s"], 1),
        "tx_errors": tx["errors"][:30],
        "tx_error_count": len(tx["errors"]),
        "locked_errors": sum(
            1 for e in tx["errors"] if "locked" in e[3] or "busy" in e[3].lower()
        ),
        "tx_retries": tx["retries"],
        "http_errors": [r for r in reqs if r[3] != 200][:20],
        "faces_done": len(tx["ai"]["face"]),
        "summary": summ,
    }
    (RES / f"{a.name}.json").write_text(json.dumps(res, indent=1, default=str))
    (RES / f"{a.name}.raw.json").write_text(
        json.dumps(
            {
                "reqs": reqs,
                "pings": pings,
                "stats": stats,
                "cpu": cpu,
                "tx": tx,
                "ta": ta,
                "te": te,
            },
            default=str,
        )
    )
    print(
        json.dumps(
            {k: v for k, v in res.items() if k != "summary"}, indent=1, default=str
        )[:6000]
    )
    for lb, d in summ.items():
        print("##", lb, json.dumps(d, default=str))


asyncio.run(main())
