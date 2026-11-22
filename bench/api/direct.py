"""Direct-call bench (no HTTP): split query cost from Python shaping, capture
the app's real SQL, EXPLAIN QUERY PLAN it, optionally profile.

usage: direct.py <dataset_dir> <case> [--runs N] [--explain] [--profile] [--sens LEVEL]

For a case it
  1. calls the service function once with SQL capture on (before_cursor_execute
     on the async engine), after tag_index.invalidate();
  2. times `runs` service calls, cache invalidated before each (cold, app);
  3. replays every captured statement with stdlib sqlite3 on a fresh
     connection per run (fetchall), timing the SQL alone;
  4. --explain prints EXPLAIN QUERY PLAN for each captured statement;
  5. --profile writes a pyinstrument (if installed) or cProfile report to
     results/prof-<dataset>-<case>.txt.
"""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

BENCH = benv.BENCH
ap = argparse.ArgumentParser()
ap.add_argument("dataset")
ap.add_argument("case")
ap.add_argument("--runs", type=int, default=10)
ap.add_argument("--explain", action="store_true")
ap.add_argument("--profile", action="store_true")
ap.add_argument("--sens", default=None)
ap.add_argument("--quiet-sql", action="store_true")
args = ap.parse_args()
ds = (BENCH / args.dataset).resolve()
benv.setup(ds / "moire.db", ds / "thumbs")

from moire.database.db import ensure_schema_sync  # noqa: E402

ensure_schema_sync()  # a copied DB may predate newer tables

from sqlalchemy import event  # noqa: E402

from moire.database.db import get_async_engine  # noqa: E402
from moire.services.tags import index as tag_index  # noqa: E402
from moire.services.tags import sensitivity as tag_sensitivity  # noqa: E402
from moire.services.tags import sensitivity_filter  # noqa: E402

tag_sensitivity.load_overrides_sync()
sensitivity_filter.load_sync()
if args.sens:
    sensitivity_filter._max = tag_sensitivity.LEVEL_OF[args.sens]

captured: list[tuple[str, tuple]] = []
capture_on = False


@event.listens_for(get_async_engine().sync_engine, "before_cursor_execute")
def _cap(conn, cursor, statement, parameters, context, executemany):
    if capture_on:
        captured.append((statement, tuple(parameters or ())))


FIX = {
    "real": {
        "r301": "prompt:earrings",
        "dense": "prompt:masterpiece",
        "mid": "prompt:absurdres",
    },
    "syn": {
        "r301": "bench_r301",
        "dense": "prompt:masterpiece",
        "mid": "prompt:absurdres",
        "r3000": "bench_r3000",
    },
}[args.dataset]


async def case_fn():
    from moire.services.tags import browse, views, rename, detail
    from moire.services.characters import pages
    from moire.services.images import feed
    from moire.services.images.feed import FeedFilter

    c = args.case
    if c.startswith("browse:"):
        src = c.split(":", 1)[1]
        return lambda: browse.browse(src)
    if c == "tags:all":
        return lambda: browse.list_tags(
            include_manual=True, include_prompt=True, merge_sources=False
        )
    if c == "tags:ai":
        return lambda: browse.list_tags(
            include_manual=False, include_prompt=False, merge_sources=False
        )
    if c == "tags:merged":
        return lambda: browse.list_tags(
            include_manual=True, include_prompt=True, merge_sources=True
        )
    if c == "characters":
        return pages.listing
    if c == "character":
        rows = await pages.listing()
        top = rows[0]["tag"]
        return lambda: pages.page(top)
    if c.startswith("detail:"):
        which = c.split(":", 1)[1]
        rows = await browse.browse("all")
        by = sorted(rows, key=lambda r: -r["count"])
        tag = {"dense": by[0]["tag"], "mid": by[len(by) // 50]["tag"]}[which]
        return lambda: detail.detail(tag, "all")
    if c == "merge":
        return views.shown_merge_suggestions
    if c == "rename.merge":
        return rename.merge_suggestions
    if c == "groups":
        return lambda: feed.list_groups(FeedFilter(), offset=0, limit=100)
    if c == "groups:deep":
        return lambda: feed.list_groups(
            FeedFilter(), offset=20000 if args.dataset == "syn" else 2000, limit=100
        )
    if c.startswith("feed:"):
        k = c.split(":", 1)[1]
        if k == "deeptop":
            # cursor of page 140 (syn) / 27 (real) under sort=top
            f = FeedFilter(sort="top")
            cur = None
            for _ in range(139 if args.dataset == "syn" else 26):
                rows, cur = await feed.list_feed(f, cursor=cur, limit=200, offset=0)
            return lambda: feed.list_feed(f, cursor=cur, limit=200, offset=0)
        if k == "search":
            from moire.services.images import search

            return lambda: search.search("zzqx", 8)
        return lambda: feed.list_feed(
            FeedFilter(tags=[FIX[k]]), cursor=None, limit=200, offset=0
        )
    if c.startswith("ids:"):
        k = c.split(":", 1)[1]
        f = FeedFilter() if k == "all" else FeedFilter(tags=[FIX[k]])
        return lambda: feed.list_ids(f, limit=20001)
    if c == "samples":
        from moire.services.tags import covers

        rows = await browse.browse("all")
        names = [r["tag"] for r in sorted(rows, key=lambda r: -r["count"])[:60]]

        async def go():
            return await asyncio.gather(*[covers.samples_for_tag(n, 4) for n in names])

        return go
    if c == "board":
        return views.shown_board_offers
    if c == "facets":
        return views.shown_facets
    if c == "groupsmap":
        return views.shown_groups
    raise SystemExit(f"unknown case {c}")


def pct(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def reset():
    tag_index.invalidate()
    from moire.services.tags import rename, views

    rename._forget_suggestions()
    views.reset_for_tests()


async def main():
    global capture_on
    fn = await case_fn()
    reset()
    capture_on = True
    await fn()
    capture_on = False
    stmts = list(captured)

    svc = []
    for _ in range(args.runs):
        reset()
        t0 = time.perf_counter()
        await fn()
        svc.append((time.perf_counter() - t0) * 1000)
    warm = []
    for _ in range(args.runs):
        t0 = time.perf_counter()
        await fn()
        warm.append((time.perf_counter() - t0) * 1000)

    # SQL alone, replayed
    sql_tot = []
    per_stmt = [[] for _ in stmts]
    for _ in range(args.runs):
        db = sqlite3.connect(f"file:{ds / 'moire.db'}?mode=ro", uri=True)
        tot = 0.0
        for i, (s, p) in enumerate(stmts):
            t0 = time.perf_counter()
            db.execute(s, p).fetchall()
            dt = (time.perf_counter() - t0) * 1000
            per_stmt[i].append(dt)
            tot += dt
        db.close()
        sql_tot.append(tot)
    load = " ".join(Path("/proc/loadavg").read_text().split()[:3])
    print(
        f"[{args.dataset}] {args.case}: service cold p50 {pct(svc, 0.5):.1f} p95 {pct(svc, 0.95):.1f} ms | "
        f"service warm p50 {pct(warm, 0.5):.1f} | SQL replay p50 {pct(sql_tot, 0.5):.1f} ms "
        f"({len(stmts)} stmts) | load {load}"
    )
    order = sorted(range(len(stmts)), key=lambda i: -statistics.median(per_stmt[i]))
    db = sqlite3.connect(f"file:{ds / 'moire.db'}?mode=ro", uri=True)
    for i in order[:6]:
        s, p = stmts[i]
        print(
            f"  stmt#{i} p50 {statistics.median(per_stmt[i]):.1f} ms  params={len(p)}"
        )
        if not args.quiet_sql:
            print("    " + " ".join(s.split())[:600])
        if args.explain:
            for row in db.execute("EXPLAIN QUERY PLAN " + s, p):
                print("     plan:", row[1], row[3])
    if args.profile:
        out = (
            BENCH / "results" / f"prof-{args.dataset}-{args.case.replace(':', '_')}.txt"
        )
        try:
            from pyinstrument import Profiler

            reset()
            prof = Profiler(interval=0.0005, async_mode="enabled")
            prof.start()
            await fn()
            prof.stop()
            out.write_text(prof.output_text(unicode=False, color=False, show_all=False))
        except ImportError:
            import cProfile
            import pstats
            import io

            reset()
            pr = cProfile.Profile()
            pr.enable()
            await fn()
            pr.disable()
            sio = io.StringIO()
            pstats.Stats(pr, stream=sio).sort_stats("cumulative").print_stats(40)
            out.write_text(sio.getvalue())
        print("  profile ->", out)


asyncio.run(main())
