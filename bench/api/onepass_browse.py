"""Diff tool (bench only): the current tags browse vs the old multi-CTE one.

usage: BENCH_WORK=<root> OLD_BROWSE=<old browse.py> onepass_browse.py <dataset_dir>
Compares (tag, count, last_used, cover) of browse._browse against the old
implementation (a copy of the pre-N2 browse.py) for every source, a bases
subset, and with the sensitivity filter on. Point it at a scratch copy.
"""

import asyncio
import importlib.util
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

ds = Path(sys.argv[1]).resolve()
old_path = os.environ["OLD_BROWSE"]
benv.setup(ds / "moire.db", ds / "thumbs")

from moire.services.tags import browse, sensitivity_filter  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "moire.services.tags._old_browse", old_path
)
old_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(old_mod)


async def timed(fn, *a, n=2):
    ts, out = [], None
    for _ in range(n):
        t0 = time.perf_counter()
        out = await fn(*a)
        ts.append(round((time.perf_counter() - t0) * 1000))
    return out, min(ts)


def key(rows):
    return {r["tag"]: (r["count"], r["last_used"], r["thumb_image_id"]) for r in rows}


async def check(label, *args):
    old, to = await timed(old_mod._browse, *args)
    new, tn = await timed(browse._browse, *args)
    a, b = key(old), key(new)
    bad = [k for k in a if a[k] != b.get(k)] + [k for k in b if k not in a]
    order = [r["tag"] for r in old] == [r["tag"] for r in new]
    print(
        f"{label:22} rows {len(a)}/{len(b)} mismatches {len(bad)} order_same {order}"
        f" | old {to} ms new {tn} ms"
    )
    for k in bad[:3]:
        print("   ", k, a.get(k), b.get(k))
    return old


async def main():
    for src in browse.SOURCES:
        rows = await check(f"source={src}", src)
        if src == "all":
            tags = [r["tag"] for r in rows]
            mid = len(tags) // 2
            subset = tags[:3] + tags[mid : mid + 3] + tags[-3:]
            await check("all bases=9", "all", subset)
            await check("ai bases=9", "ai", subset)
            await check("manual bases=9", "manual", subset)
    for lvl in (0, 1):
        sensitivity_filter._max = lvl
        await check(f"filter<={lvl} all", "all")
        await check(f"filter<={lvl} prompt", "prompt")
    sensitivity_filter._max = None


asyncio.run(main())
