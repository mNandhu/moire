"""First-ask cost of ?size=small (made on demand, not by the scan) vs the
second ask and the plain thumbnail. usage: small_thumb.py <port> [N] [--parallel K]"""

import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
import httpx

port = int(sys.argv[1])
n = int(sys.argv[2]) if len(sys.argv) > 2 else 60
par = int(sys.argv[sys.argv.index("--parallel") + 1]) if "--parallel" in sys.argv else 1
A = f"http://127.0.0.1:{port}/api/v1"
cli = httpx.Client(timeout=60, headers={"Accept-Encoding": "identity"})
ids = [
    r["_id"]
    for r in cli.get(f"{A}/images", params={"limit": 1000, "sort": "oldest"}).json()
][-n:]


def t(url):
    t0 = time.perf_counter()
    r = cli.get(url)
    assert r.status_code == 200, (r.status_code, url)
    return (time.perf_counter() - t0) * 1000, len(r.content)


out = {}
for label, q in (
    ("thumb", ""),
    ("small first ask", "?size=small"),
    ("small second ask", "?size=small"),
):
    t0 = time.perf_counter()
    with ThreadPoolExecutor(par) as ex:
        r = list(ex.map(lambda i: t(f"{A}/images/{i}/thumb{q}"), ids))
    wall = time.perf_counter() - t0
    lat = sorted(x[0] for x in r)
    out[label] = (
        round(statistics.median(lat), 1),
        round(lat[int(0.95 * len(lat))], 1),
        round(statistics.mean(x[1] for x in r) / 1024, 1),
        round(wall, 2),
    )
    print(
        f"{label:18s} parallel={par} n={len(ids)} p50 {out[label][0]} ms p95 {out[label][1]} ms  avg {out[label][2]} KB  wall {out[label][3]} s"
    )
