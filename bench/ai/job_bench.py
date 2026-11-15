"""Items 2-3: an AI job through the API while the app is in use.

Against a running serve.py backend (lifespan on):
  - open-loop reader at --rps (feed, /tags all sources, /tags/browse, detail, thumb)
  - frontend polls at their real cadences: ai/status 2 s, ai/coverage 3 s,
    activity 1.5 s, sensitivity 5 s, ai/jobs/{id} 1.5 s, tags/characters 5 s
  - /health every 50 ms (event-loop lag), /__bench/stats every 250 ms
  - /tags (AI only) every 500 ms: tag-view staleness against the server's commit log
phases: idle (--idle s) -> job (POST /ai/tag-untagged limit=--limit) until it ends -> tail

usage: job_bench.py <name> --port P [--limit 1000] [--cancel-after S] [--no-load]
       [--action tag-untagged|none|faces]
"""

import argparse
import asyncio
import bisect
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
ap.add_argument("--limit", type=int, default=1000)
ap.add_argument("--rps", type=float, default=10)
ap.add_argument("--idle", type=float, default=15)
ap.add_argument("--tail", type=float, default=10)
ap.add_argument("--max", type=float, default=1200)
ap.add_argument("--cancel-after", type=float)
ap.add_argument(
    "--no-load", action="store_true", help="no reader / fe polls (pure job)"
)
ap.add_argument("--action", default="tag-untagged")
ap.add_argument(
    "--duration", type=float, default=60, help="--action none/faces: seconds"
)
a = ap.parse_args()
B = f"http://127.0.0.1:{a.port}"
A = f"{B}/api/v1"


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
        }
        if xs
        else None
    )


async def main():
    lim = httpx.Limits(max_connections=64, max_keepalive_connections=64)
    async with httpx.AsyncClient(
        timeout=120, limits=lim, headers={"Accept-Encoding": "identity"}
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
            ("libraries", lambda: f"{A}/libraries"),
        ]
        job_id = [None]
        polls = [
            ("ai_status", 2.0, lambda: f"{A}/ai/status"),
            ("ai_coverage", 3.0, lambda: f"{A}/ai/coverage"),
            ("activity", 1.5, lambda: f"{A}/activity"),
            ("sensitivity", 5.0, lambda: f"{A}/sensitivity"),
            ("ai_job", 1.5, lambda: f"{A}/ai/jobs/{job_id[0]}" if job_id[0] else None),
            ("characters", 5.0, lambda: f"{A}/tags/characters"),
        ]
        reqs, pings, stats, views, jobsnap, events = [], [], [], [], [], []
        phase = ["idle"]
        stop = asyncio.Event()

        async def one(kind, url):
            t0 = time.perf_counter()
            try:
                r = await cli.get(url)
                code = r.status_code
            except Exception as e:  # noqa: BLE001
                code = repr(e)[:100]
                r = None
            reqs.append(
                (t0 - T0, kind, (time.perf_counter() - t0) * 1000, code, phase[0])
            )
            return r

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
                url = f()
                t0 = time.perf_counter()
                if url:
                    r = await one(kind, url)
                    if kind == "ai_job" and r is not None and r.status_code == 200:
                        jobsnap.append((time.time(), r.json()))
                await asyncio.sleep(max(0, every - (time.perf_counter() - t0)))

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

        async def viewer():
            while not stop.is_set():
                t0 = time.perf_counter()
                tw = time.time()
                try:
                    r = await cli.get(f"{A}/tags")
                    views.append((tw, time.time(), sum(x["count"] for x in r.json())))
                except Exception:
                    pass
                await asyncio.sleep(max(0, 0.5 - (time.perf_counter() - t0)))

        await cli.post(f"{B}/__bench/reset")
        base_view = sum(x["count"] for x in (await cli.get(f"{A}/tags")).json())
        T0 = time.perf_counter()
        bg = [asyncio.create_task(c()) for c in (pinger, statter, viewer)]
        if not a.no_load:
            bg.append(asyncio.create_task(reader()))
            bg += [asyncio.create_task(poller(*p)) for p in polls]
        await asyncio.sleep(a.idle)
        phase[0] = "action"
        ta = time.perf_counter()
        tw_start = time.time()
        events.append(("action_start", ta - T0))
        final = None
        if a.action == "tag-untagged":
            r = await cli.post(f"{A}/ai/tag-untagged", json={"limit": a.limit})
            js = r.json()
            job_id[0] = js["job_id"]
            events.append(("enqueued", time.perf_counter() - T0, js))
            cancel_sent = None
            while time.perf_counter() - ta < a.max:
                j = (await cli.get(f"{A}/ai/jobs/{job_id[0]}")).json()
                if j.get("status") in ("done", "error", "cancelled"):
                    final = j
                    break
                if (
                    a.cancel_after
                    and cancel_sent is None
                    and j.get("started_at")
                    and time.time() - j["started_at"] >= a.cancel_after
                ):
                    cancel_sent = time.time()
                    cr = await cli.post(f"{A}/ai/jobs/{job_id[0]}/cancel")
                    events.append(
                        (
                            "cancel_sent",
                            time.perf_counter() - T0,
                            cr.status_code,
                            (time.time() - cancel_sent) * 1000,
                        )
                    )
                await asyncio.sleep(0.05)
            if cancel_sent:
                events.append(
                    ("cancel_latency_ms", round((time.time() - cancel_sent) * 1000, 1))
                )
        elif a.action in ("faces", "faces+tag"):
            r = await cli.post(f"{B}/__bench/faces", params={"n": a.limit})
            events.append(("faces_queued", time.perf_counter() - T0, r.json()))
            if a.action == "faces+tag":
                r = await cli.post(f"{A}/ai/tag-untagged", json={"limit": a.limit})
                job_id[0] = r.json()["job_id"]
            tf = None
            while time.perf_counter() - ta < a.max:
                fs = (await cli.get(f"{A}/ai/faces")).json()
                if tf is None and fs.get("pending", 0) == 0:
                    tf = time.perf_counter() - ta
                    events.append(("faces_drained_s", round(tf, 2)))
                jd = True
                if job_id[0]:
                    j = (await cli.get(f"{A}/ai/jobs/{job_id[0]}")).json()
                    jd = j.get("status") in ("done", "error", "cancelled")
                    if jd:
                        final = j
                if tf is not None and jd:
                    break
                await asyncio.sleep(0.1)
        else:
            await asyncio.sleep(a.duration)
        tw_end = time.time()
        events.append(("action_end", time.perf_counter() - T0))
        action_s = time.perf_counter() - ta
        phase[0] = "tail"
        await asyncio.sleep(a.tail)
        stop.set()
        await asyncio.gather(*bg)
        ai = (await cli.get(f"{B}/__bench/ai")).json()

    summ = {}
    kinds = [e[0] for e in eps] + [p[0] for p in polls]
    for ph in ("idle", "action", "tail"):
        for kind in kinds + ["ALL_reader"]:
            sel = [
                r
                for r in reqs
                if r[4] == ph
                and (
                    r[1] == kind
                    or (kind == "ALL_reader" and r[1] in {e[0] for e in eps})
                )
            ]
            if sel:
                summ[f"{ph}/{kind}"] = {
                    **lat([r[2] for r in sel]),
                    "errors": sum(1 for r in sel if r[3] != 200),
                }
        pl = [p[1] for p in pings if p[2] == ph and p[1] >= 0]
        if pl:
            summ[f"{ph}/health"] = {
                **lat(pl),
                "over_100ms": sum(x > 100 for x in pl),
                "over_500ms": sum(x > 500 for x in pl),
            }

    # ---- pipeline stages (seconds -> ms)
    def ms(rows):
        return [d * 1000 for _, d in rows]

    st = {}
    for k in ("load", "tag_one", "predict_thread", "write", "face", "model_load"):
        if ai[k]:
            v = ms(ai[k])
            st[k] = {
                "mean": round(statistics.mean(v), 1),
                "p50": pct(v, 0.5),
                "p95": pct(v, 0.95),
                "max": round(max(v), 1),
                "n": len(v),
                "sum_s": round(sum(v) / 1000, 1),
            }
    # gap between one tag_one ending and the next starting = waiting on the prefetch
    to = sorted(ai["tag_one"])
    gaps = [(to[i + 1][0] - (to[i][0] + to[i][1])) * 1000 for i in range(len(to) - 1)]
    if gaps:
        st["gap_between_images"] = {
            "mean": round(statistics.mean(gaps), 1),
            "p50": pct(gaps, 0.5),
            "p95": pct(gaps, 0.95),
            "max": round(max(gaps), 1),
            "over_20ms": sum(g > 20 for g in gaps),
        }
    if ai["tag_one"] and ai["predict_thread"] and ai["write"]:
        other = [
            t1[1] - p[1] - w[1]
            for t1, p, w in zip(
                sorted(ai["tag_one"]), sorted(ai["predict_thread"]), sorted(ai["write"])
            )
        ]
        st["tag_one_overhead_ms(lock+to_thread+params)"] = round(
            statistics.mean(other) * 1000, 1
        )

    # ---- tag view staleness: age of the oldest commit a /tags answer misses
    commits = ai["commits"]
    ct = [c[0] for c in commits]
    cp = [c[1] for c in commits]
    stale = []
    for tw_req, tw_resp, s in views:
        if not commits:
            break
        seen = s - base_view
        k = bisect.bisect_right(cp, seen)  # commits[:k] reflected
        # the next unreflected commit that happened before the request
        if k < len(commits) and ct[k] <= tw_req:
            stale.append((tw_req, tw_req - ct[k]))
        else:
            stale.append((tw_req, 0.0))
    during = [x for t, x in stale if tw_start <= t <= tw_end]
    after = [(t - tw_end, x) for t, x in stale if t > tw_end]
    staleness = None
    if during:
        staleness = {
            "polls": len(during),
            "p50_s": pct(during, 0.5),
            "p95_s": pct(during, 0.95),
            "max_s": round(max(during), 1),
            "fresh_polls": sum(x == 0 for x in during),
            "first_fresh_after_end_s": next(
                (round(t, 2) for t, x in after if x == 0), None
            ),
            "final_view_minus_pairs": (views[-1][2] - base_view - (cp[-1] if cp else 0))
            if views
            else None,
        }

    act = [s for s in stats if s["phase"] == "action"] or stats
    first, last = stats[0], stats[-1]
    idle_cpu = [s for s in stats if s["phase"] == "idle"]
    res = {
        "name": a.name,
        "load": benv.load_avg(),
        "action_s": round(action_s, 2),
        "events": events,
        "job": {
            k: final.get(k)
            for k in (
                "status",
                "total",
                "done",
                "failed",
                "skipped",
                "rate",
                "elapsed_s",
                "started_at",
                "created_at",
                "finished_at",
            )
        }
        if final
        else None,
        "model_phase_s": round(final["started_at"] - final["created_at"], 2)
        if final and final.get("started_at")
        else None,
        "summary": summ,
        "stages_ms": st,
        "staleness": staleness,
        "wal_MB": {
            "start": first["wal_MB"],
            "max": max(s["wal_MB"] for s in stats),
            "end": last["wal_MB"],
        },
        "rss_MB": {
            "idle": first["rss_MB"],
            "action_max": max(s["rss_MB"] for s in act),
            "end": last["rss_MB"],
            "hwm": last["hwm_MB"],
        },
        "threads_max": max(s["threads"] for s in stats),
        "invalidations_during": (act[-1]["invalidate"] - first["invalidate"]),
        "soft_invalidations_during": (
            act[-1]["invalidate_soft"] - first["invalidate_soft"]
        ),
        "view_builds": {
            k: v - first["builds"].get(k, 0) for k, v in last["builds"].items()
        },
        "view_build_s": round(last["build_s"] - first["build_s"], 2),
        "server_cpu_cores": {
            "idle": round(
                (idle_cpu[-1]["cpu_s"] - idle_cpu[0]["cpu_s"])
                / max(0.1, idle_cpu[-1]["t"] - idle_cpu[0]["t"]),
                2,
            )
            if len(idle_cpu) > 1
            else None,
            "action": round(
                (act[-1]["cpu_s"] - act[0]["cpu_s"])
                / max(0.1, act[-1]["t"] - act[0]["t"]),
                2,
            ),
        },
        "build_log_during": [
            b for b in ai["build_log"] if tw_start - 1 <= b[0] <= tw_end + a.tail
        ],
    }
    out = benv.BENCH / "results" / f"{a.name}.json"
    out.write_text(json.dumps(res, indent=1, default=str))
    (benv.BENCH / "results" / f"{a.name}.raw.json").write_text(
        json.dumps(
            {
                "reqs": reqs,
                "pings": pings,
                "stats": stats,
                "views": views,
                "ai": ai,
                "jobsnap": jobsnap[-3:],
            },
            default=str,
        )
    )
    short = {k: v for k, v in res.items() if k != "build_log_during"}
    print(json.dumps(short, indent=1, default=str))


asyncio.run(main())
