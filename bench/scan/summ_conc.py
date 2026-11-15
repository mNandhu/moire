"""Print the concurrency.py result JSONs. usage: summ_conc.py name..."""

import json
import sys

for n in sys.argv[1:]:
    d = json.load(open(f"results/{n}.json"))
    print(
        "##",
        n,
        "action_s",
        d["action_s"],
        "wal max/end",
        d["wal_MB_max"],
        d["wal_MB_end"],
        "rss",
        d["rss_MB"],
        "inval",
        d["invalidations_during"],
        "soft",
        d["soft_invalidations_during"],
        "builds",
        d["view_builds_during"],
        d["view_build_s_during"],
        "cpu",
        d["server_cpu_s"],
        "rep",
        d["last_reproject"],
        "load",
        d["load"],
        "errors",
        len(d["errors"]),
        "events",
        d["events"],
    )
    for k, v in d["summary"].items():
        print("  ", k, v)
    for e in d["errors"][:3]:
        print("  ERR", e)
