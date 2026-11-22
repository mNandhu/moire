"""Tag-view staleness bench (N3, N11): no HTTP, no DB writes.

usage: stale_bench.py <dataset> [--job-seconds 60] [--rate 7]

1. job end: warm the Tags browse and the characters list, call
   ``image_tags.end_bulk_writes()`` (what an AI job does when it ends), then
   time the next read of each, the wait a viewer sees.
2. simulated job: soft-invalidate ``--rate`` times a second for
   ``--job-seconds`` (an AI job's per-image writes) while a reader asks for the
   browse rows and the characters list once a second; counts the browse
   builds, their total time, and the reader's latency.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("dataset")
ap.add_argument("--job-seconds", type=float, default=60)
ap.add_argument("--rate", type=float, default=7)
args = ap.parse_args()
ds = (benv.BENCH / args.dataset).resolve()
benv.setup(ds / "moire.db", ds / "thumbs")

from moire.services.characters import pages  # noqa: E402
from moire.services.tags import browse, image_tags  # noqa: E402
from moire.services.tags import index as tag_index  # noqa: E402

builds: list[float] = []
_orig = browse._browse


async def _counted(*a, **kw):
    t0 = time.perf_counter()
    try:
        return await _orig(*a, **kw)
    finally:
        builds.append(time.perf_counter() - t0)


browse._browse = _counted


async def timed(fn) -> float:
    t0 = time.perf_counter()
    await fn()
    return (time.perf_counter() - t0) * 1000


async def characters():
    return await pages.listing()


async def main():
    tag_index.invalidate()
    await browse.browse("all")
    await characters()
    await asyncio.sleep(0.5)

    # --- 1. job end (as services/ai/jobs.py ends a job)
    try:
        image_tags.end_bulk_writes(refresh=True)
    except TypeError:  # before N3
        image_tags.end_bulk_writes()
    b = await timed(lambda: browse.browse("all"))
    c = await timed(characters)
    t0 = time.perf_counter()
    while tag_index._lookup("views", "browse:all", None)[0] != "fresh":
        await asyncio.sleep(0.05)
    fresh = (time.perf_counter() - t0) * 1000
    print(f"job end: next browse {b:.0f} ms, characters {c:.0f} ms, fresh after +{fresh:.0f} ms")

    # --- 2. simulated job
    await asyncio.sleep(1)
    builds.clear()
    lat: list[float] = []
    stop = time.monotonic() + args.job_seconds

    async def writer():
        while time.monotonic() < stop:
            tag_index.invalidate_soft()
            await asyncio.sleep(1 / args.rate)

    async def reader():
        while time.monotonic() < stop:
            lat.append(await timed(lambda: browse.browse("all")))
            lat.append(await timed(characters))
            await asyncio.sleep(1)

    await asyncio.gather(writer(), reader())
    image_tags.end_bulk_writes()
    await asyncio.sleep(0.2)
    lat.sort()
    print(
        f"job {args.job_seconds:.0f} s: browse builds {len(builds)}, "
        f"build time {sum(builds):.1f} s, reader p50 {statistics.median(lat):.0f} ms "
        f"max {lat[-1]:.0f} ms"
    )
    await tag_index.cancel_builds()


asyncio.run(main())
