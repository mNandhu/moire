"""Compact per-window tables from combo.py result JSONs. usage: table.py name..."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

R = benv.BENCH / "results"


def g(d, *ks):
    for k in ks:
        if d is None:
            return None
        d = d.get(k) if isinstance(d, dict) else None
    return d


for n in sys.argv[1:]:
    d = json.load(open(R / f"{n}.json"))
    print(f"\n### {n}  actions={d['actions']} seq={d['seq']} action_s={d['action_s']}")
    print("timeline:", d["timeline_from_action"][:14])
    print(
        "jobs:", d["jobs"], "lib:", d["bench_library"], "faces_done:", d["faces_done"]
    )
    print(
        "wal:",
        d["wal_MB"],
        "rss:",
        d["rss_MB"],
        "inval:",
        d["invalidations"],
        "soft:",
        d["soft_invalidations"],
        "builds:",
        d["view_builds"],
        d["view_build_s"],
        "s; server cpu s:",
        d["server_cpu_s"],
    )
    print(
        "tx errors:",
        d["tx_error_count"],
        "locked:",
        d["locked_errors"],
        "retries:",
        len(d["tx_retries"]),
        "http errors:",
        len(d["http_errors"]),
        d["tx_errors"][:3],
        d["http_errors"][:3],
    )
    hdr = (
        "window",
        "span",
        "rd p50",
        "p95",
        "max",
        "brw p50",
        "feed p95",
        "hl p50",
        "p95",
        "max",
        ">100",
        ">500",
        "sysC",
        "srvC",
        "gpu%",
        "ai/s",
        "aiW p50",
        "p95",
        "max",
        "face/s",
    )
    print(" | ".join(hdr))
    for lb, s in d["summary"].items():
        row = (
            lb,
            s.get("span_s"),
            g(s, "ALL", "p50"),
            g(s, "ALL", "p95"),
            g(s, "ALL", "max"),
            g(s, "browse", "p50"),
            g(s, "feed", "p95"),
            g(s, "health", "p50"),
            g(s, "health", "p95"),
            g(s, "health", "max"),
            g(s, "health", "over_100"),
            g(s, "health", "over_500"),
            g(s, "sys_cores_busy", "mean"),
            s.get("server_cores"),
            g(s, "gpu", "util_mean"),
            s.get("ai_img_per_s"),
            g(s, "ai_write_ms", "p50"),
            g(s, "ai_write_ms", "p95"),
            g(s, "ai_write_ms", "max"),
            s.get("face_per_s"),
        )
        print(" | ".join(str(x) for x in row))
    print("tx (window: kind side n p50 p95 max sum_s)")
    for lb, s in d["summary"].items():
        for k, v in s.items():
            if k.startswith("tx_") and v:
                print(
                    f"   {lb:18s} {k:22s} n={v['n']:5d} p50={v['p50']} p95={v['p95']} max={v['max']} sum={v['sum_s']}"
                )
