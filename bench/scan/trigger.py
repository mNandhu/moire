"""Time from an extraction-settings save (PUT /rules/guess-keywords) to the
reprojection showing in /activity, and to it ending. usage: trigger.py <port> [same|change]"""

import sys
import time
import httpx

port = int(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "same"
A = f"http://127.0.0.1:{port}/api/v1"
B = f"http://127.0.0.1:{port}"
c = httpx.Client(timeout=120)
cur = c.get(f"{A}/rules/guess-keywords").json()
body = {
    "guess_positive": list(cur["guess_positive"]),
    "guess_negative": list(cur["guess_negative"]),
}
if mode == "change":
    body["guess_positive"] = body["guess_positive"] + ["benchkeyword"]
s0 = c.get(f"{B}/__bench/stats").json()
t0 = time.perf_counter()
r = c.put(f"{A}/rules/guess-keywords", json=body)
tput = time.perf_counter() - t0
seen = end = None
maxdone = None
while time.perf_counter() - t0 < 600:
    items = c.get(f"{A}/activity").json()
    items = items.get("items", items) if isinstance(items, dict) else items
    rep = [i for i in items if i.get("kind") == "reproject"]
    now = time.perf_counter() - t0
    if rep and seen is None:
        seen = now
    if rep:
        maxdone = rep[0].get("total")
    if seen is not None and not rep:
        end = now
        break
    if seen is None and now > 5:
        break
    time.sleep(0.05)
s1 = c.get(f"{B}/__bench/stats").json()
print(
    f"mode={mode} PUT {r.status_code} {tput * 1000:.0f} ms; activity shows reproject at {seen and round(seen, 2)} s, ends at {end and round(end, 2)} s; total={maxdone}; invalidations {s1['invalidate'] - s0['invalidate']}; rss {s1['rss_MB']} MB hwm {s1['hwm_MB']} MB"
)
