"""Summarize a gpumon csv over busy samples (util > 0). usage: gpusum.py <csv>"""

import csv
import statistics
import sys

rows = [r for r in csv.reader(open(sys.argv[1])) if len(r) >= 7]


def f(x):
    try:
        return float(x)
    except ValueError:
        return None


u = [f(r[1]) for r in rows]
m = [f(r[2]) for r in rows]
c = [f(r[3]) for r in rows]
p = [f(r[4]) for r in rows]
t = [f(r[5]) for r in rows]
busy = [i for i, x in enumerate(u) if x and x > 0]
if not busy:
    print("no busy samples")
    sys.exit()
b = lambda xs: [xs[i] for i in busy if xs[i] is not None]  # noqa: E731,E741
print(
    {
        "samples": len(rows),
        "busy": len(busy),
        "util_mean_busy": round(statistics.mean(b(u)), 1),
        "util_p50_busy": statistics.median(b(u)),
        "mem_max_MiB": max(x for x in m if x is not None),
        "sm_clock_mean_busy": round(statistics.mean(b(c))),
        "sm_clock_min_busy": min(b(c)),
        "power_mean_busy": round(statistics.mean(b(p)), 1),
        "temp_max": max(x for x in t if x is not None),
        "pstates": sorted({r[6].strip() for r in rows}),
    }
)
