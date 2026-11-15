"""Median table of web-bench.cjs `pages` runs. usage: sum-pages.py <out/pages-*.json>..."""

import json
import sys
import statistics as st

runs = json.load(open(sys.argv[1]))
print(len(runs), "runs")


def m(v):
    v = [x for x in v if x is not None]
    return f"{st.median(v):.0f} [{min(v):.0f}..{max(v):.0f}]"


for p in runs[0]:
    for mode in ("direct", "nav"):
        xs = [r[p][mode] for r in runs]
        slow = {}
        for x in xs:
            for s in x["api"]["slow"][:4]:
                slow.setdefault(s["u"][:55], []).append(s["ms"])
        print(
            f"{p:38} {mode:6} quiet {m([x['quietMs'] for x in xs])} {'lcp ' + m([x.get('lcp') or 0 for x in xs]) if mode == 'direct' else ''} LT n {m([x['lt']['n'] for x in xs])} sum {m([x['lt']['sum'] for x in xs])} max {m([x['lt']['max'] for x in xs])} api {m([x['api']['n'] for x in xs])} {m([x['api']['kb'] for x in xs])}KB dec {m([x['api']['decKB'] for x in xs])}KB thumbs {m([x['thumbs'] for x in xs])}"
        )
        print(
            "      slow:",
            "; ".join(
                f"{u} {m(v)}"
                for u, v in sorted(slow.items(), key=lambda kv: -st.median(kv[1]))[:4]
            ),
            "| dup",
            xs[0]["api"]["dup"],
            "| failed",
            xs[0].get("failedApi"),
        )
        if "react" in xs[0]:
            print("      react:", xs[0]["react"])
        if mode == "nav":
            print("      loaf:", xs[0]["loafTop"][:3])
