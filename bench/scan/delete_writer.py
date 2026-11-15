"""Item 7: DELETE a library while another client writes (rating POST every 100 ms)
and the scan-style sync writer path is idle. Reports the delete time and the
writer's latency during it. usage: delete_writer.py <port> <library_id>"""

import sys
import threading
import time
import httpx

port, lib = int(sys.argv[1]), sys.argv[2]
A = f"http://127.0.0.1:{port}/api/v1"
c = httpx.Client(timeout=120)
ids = [
    r["_id"]
    for r in c.get(f"{A}/images", params={"limit": 1000}).json()
    if not r["_id"].startswith(lib)
][:50]
lat, stop = [], threading.Event()


def writer():
    w = httpx.Client(timeout=120)
    i = 0
    while not stop.is_set():
        t0 = time.perf_counter()
        r = w.post(
            f"{A}/images/{ids[i % len(ids)]}/rating",
            json={"rating": ["general", "sensitive"][i % 2]},
        )
        lat.append((t0 - T0, (time.perf_counter() - t0) * 1000, r.status_code))
        i += 1
        time.sleep(0.1)


T0 = time.perf_counter()
th = threading.Thread(target=writer)
th.start()
time.sleep(2)
t0 = time.perf_counter()
r = c.delete(f"{A}/libraries/{lib}")
td = time.perf_counter() - t0
time.sleep(2)
stop.set()
th.join()
during = [l for t, l, s in lat if t0 - T0 <= t <= t0 - T0 + td]  # noqa: E731,E741
before = [l for t, l, s in lat if t < t0 - T0]  # noqa: E731,E741
print(
    f"delete {r.status_code} {td:.2f}s; rating writes before: n={len(before)} max {max(before):.0f} ms; during: n={len(during)} max {max(during) if during else 0:.0f} ms; statuses {sorted(set(s for _, _, s in lat))}"
)
