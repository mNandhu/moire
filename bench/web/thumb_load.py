"""Keep-alive load generator: raw asyncio sockets, so the client adds little.
usage: load.py PORT URLFILE N CONC [--cond] [--cold]"""

import asyncio
import sys
import time
import random
import json

port = int(sys.argv[1])
urls = [l.strip() for l in open(sys.argv[2])]  # noqa: E731,E741
n = int(sys.argv[3])
conc = int(sys.argv[4])
random.seed(1)
random.shuffle(urls)
q = [urls[i % len(urls)] for i in range(n)]
lat = []
ttfb = []
bytes_ = 0
bad = 0


async def worker():
    global bytes_, bad
    r, w = await asyncio.open_connection("127.0.0.1", port)
    while q:
        u = q.pop()
        t = time.perf_counter()
        w.write(f"GET {u} HTTP/1.1\r\nHost: x\r\nAccept: */*\r\n\r\n".encode())
        head = await r.readuntil(b"\r\n\r\n")
        t1 = time.perf_counter()
        status = head[9:12]
        cl = 0
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                cl = int(line.split(b":")[1])
        if cl:
            await r.readexactly(cl)
        t2 = time.perf_counter()
        if status != b"200":
            bad += 1
        lat.append((t2 - t) * 1e3)
        ttfb.append((t1 - t) * 1e3)
        bytes_ += cl
    w.close()


async def main():
    t = time.perf_counter()
    await asyncio.gather(*[worker() for _ in range(conc)])
    return time.perf_counter() - t


el = asyncio.run(main())
lat.sort()
ttfb.sort()
p = lambda v, x: v[min(len(v) - 1, int(len(v) * x))]  # noqa: E731,E741
print(
    json.dumps(
        dict(
            conc=conc,
            rps=round(len(lat) / el),
            p50=round(p(lat, 0.5), 2),
            p95=round(p(lat, 0.95), 2),
            p99=round(p(lat, 0.99), 2),
            ttfb50=round(p(ttfb, 0.5), 2),
            MBps=round(bytes_ / el / 1e6),
            bad=bad,
            n=len(lat),
        )
    )
)
