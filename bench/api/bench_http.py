"""HTTP bench against a running bench server (start.sh).

usage: bench_http.py <port> <dataset: real|syn> <suite> [--runs 30] [--warm 3] [--filter substr]

suites: feed, tags, media, misc, sens (sens toggles the sensitivity filter on
via the API for its run, then off again).

Per case: `warm` warmups, then `runs` timed requests (warm). Cases marked
cold also run `runs` times with POST /__bench/invalidate before each (the
invalidate is not timed): app-cache cold, OS page cache and SQLite pool warm.
Accept-Encoding: identity (D5 quoted identity numbers). Load average is read
from /proc/loadavg before and after each case. Results append to
results/http-<dataset>-<suite>.json.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlencode

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

BENCH = benv.BENCH

ap = argparse.ArgumentParser()
ap.add_argument("port", type=int)
ap.add_argument("dataset")
ap.add_argument("suite")
ap.add_argument("--runs", type=int, default=30)
ap.add_argument("--warm", type=int, default=3)
ap.add_argument("--filter", default="")
ap.add_argument("--tag", default="")  # output file tag
args = ap.parse_args()

BASE = f"http://127.0.0.1:{args.port}"
API = f"{BASE}/api/v1"
cli = httpx.Client(timeout=120, headers={"Accept-Encoding": "identity"})

# Filter fixtures per dataset (see report: picked by match count).
FIX = {
    "real": {
        "rare": "prompt:sash",  # 30
        "r300": "prompt:earrings",  # 298
        "mid": "prompt:absurdres",  # 1011
        "dense": "prompt:masterpiece",  # 3347
        "dense2": "prompt:1girl",  # 2846
        "t_rare": "sash",
        "t_r300": "earrings",
        "t_mid": "absurdres",
        "t_dense": "masterpiece",
    },
    "syn": {
        "rare": "bench_r30",
        "r299": "bench_r299",
        "r301": "bench_r301",
        "r300": "bench_r301",
        "r3000": "bench_r3000",
        "nat_rare": "prompt:sash",  # 150 (5x30)
        "mid": "prompt:absurdres",  # ~5.6k
        "dense": "prompt:masterpiece",  # ~18.6k
        "dense2": "prompt:1girl",
        "t_rare": "benchterm_r30",
        "t_r299": "benchterm_r299",
        "t_r300": "benchterm_r301",
        "t_r3000": "benchterm_r3000",
        "t_mid": "absurdres",
        "t_dense": "masterpiece",
    },
}[args.dataset]


def loadavg() -> str:
    return " ".join(Path("/proc/loadavg").read_text().split()[:3])


def pct(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def q(path: str, **params) -> str:
    items = []
    for k, v in params.items():
        if isinstance(v, (list, tuple)):
            items += [(k, x) for x in v]
        elif v is not None:
            items.append((k, v))
    return f"{API}/{path}" + (("?" + urlencode(items)) if items else "")


def req(method: str, url: str, headers=None):
    t0 = time.perf_counter()
    r = cli.request(method, url, headers=headers)
    body = r.content
    dt = (time.perf_counter() - t0) * 1000
    return dt, r, len(body)


def invalidate():
    cli.post(f"{BASE}/__bench/invalidate")


results = []


def run(name, url, *, cold=False, method="GET", headers=None, note=""):
    if args.filter and args.filter not in name:
        return None
    la0 = loadavg()
    for _ in range(args.warm):
        req(method, url, headers)
    warm = []
    size = status = None
    for _ in range(args.runs):
        dt, r, n = req(method, url, headers)
        warm.append(dt)
        size, status = n, r.status_code
    out = {
        "name": name,
        "url": url.replace(API, ""),
        "status": status,
        "bytes": size,
        "warm_p50": pct(warm, 0.5),
        "warm_p95": pct(warm, 0.95),
        "warm_min": min(warm),
        "note": note,
    }
    if cold:
        cs = []
        for _ in range(args.runs):
            invalidate()
            dt, r, n = req(method, url, headers)
            cs.append(dt)
        out.update(cold_p50=pct(cs, 0.5), cold_p95=pct(cs, 0.95), cold_min=min(cs))
    out["load"] = f"{la0} -> {loadavg()}"
    results.append(out)
    c = f"cold {out['cold_p50']:8.1f}/{out['cold_p95']:8.1f}" if cold else " " * 22
    print(
        f"{name:42s} {status} {c}  warm {out['warm_p50']:8.1f}/{out['warm_p95']:8.1f} ms  {size:>9}B  load {out['load']}",
        flush=True,
    )
    return out


def walk(params: dict, pages: int, limit=200):
    """Cursor for page `pages` (1-based: the cursor that fetches that page)."""
    cur = None
    for i in range(pages - 1):
        r = cli.get(q("images", limit=limit, cursor=cur, **params))
        cur = r.headers.get("X-Next-Cursor")
        if not cur or not r.json():
            return None, i + 1
    return cur, pages


def n_pages(params: dict, limit=200) -> int:
    ids = cli.get(q("images/ids", **params)).json()["ids"]
    return max(1, (len(ids) + limit - 1) // limit)


def feed_suite():
    syn = args.dataset == "syn"
    lib = cli.get(q("libraries")).json()
    # Biggest library by image count.
    counts = {}
    for row in cli.get(q("images/ids")).json()["ids"]:
        counts[row.split(":", 1)[0]] = counts.get(row.split(":", 1)[0], 0) + 1
    big = max(counts, key=counts.get)
    print(f"# libraries={len(lib)} biggest={counts[big]} images", flush=True)

    for sort in ("newest", "oldest", "top"):
        run(f"feed first {sort} l200", q("images", limit=200, sort=sort))
    run("feed first newest l100", q("images", limit=100))
    run("feed first newest l1000", q("images", limit=1000))
    total = n_pages({})
    deeps = (50, 140) if syn else (13, total)
    for sort in ("newest", "oldest", "top"):
        for d in deeps:
            cur, got = walk({"sort": sort}, d)
            if cur:
                run(
                    f"feed deep{d} {sort} l200",
                    q("images", limit=200, sort=sort, cursor=cur),
                )
    # offset paging (deprecated) for contrast
    run(
        "feed offset=10000 newest" if syn else "feed offset=2600 newest",
        q("images", limit=200, offset=10000 if syn else 2600),
    )

    # library
    run("feed lib first", q("images", limit=200, library_id=big))
    lp = n_pages({"library_id": big})
    cur, got = walk({"library_id": big}, lp)
    if cur:
        run(
            f"feed lib deep{lp}(last)",
            q("images", limit=200, library_id=big, cursor=cur),
        )
    run("feed lib first top", q("images", limit=200, library_id=big, sort="top"))

    # tag filters
    tagkeys = [
        k
        for k in ("rare", "r299", "r300", "r301", "nat_rare", "mid", "r3000", "dense")
        if k in FIX
    ]
    for k in tagkeys:
        tag = FIX[k]
        run(f"feed tag {k}", q("images", limit=200, tags=tag))
        run(f"ids  tag {k}", q("images/ids", tags=tag))
    base = FIX["rare"].split(":")[-1]
    run("feed any:rare", q("images", limit=200, tags=f"any:{base}"))
    run(
        "feed any:dense",
        q("images", limit=200, tags="any:" + FIX["dense"].split(":")[-1]),
    )
    run("feed tag dense top", q("images", limit=200, tags=FIX["dense"], sort="top"))
    run("feed tag mid oldest", q("images", limit=200, tags=FIX["mid"], sort="oldest"))
    # deep page within a dense tag
    dp = n_pages({"tags": FIX["dense"]})
    cur, got = walk({"tags": FIX["dense"]}, max(2, dp // 2))
    if cur:
        run(
            f"feed tag dense deep{got}",
            q("images", limit=200, tags=FIX["dense"], cursor=cur),
        )
    cur, got = walk({"tags": FIX["mid"]}, max(2, n_pages({"tags": FIX["mid"]})))
    if cur:
        run(
            f"feed tag mid deep{got}(last)",
            q("images", limit=200, tags=FIX["mid"], cursor=cur),
        )

    # prompt terms
    for k in ("t_rare", "t_r299", "t_r300", "t_mid", "t_r3000", "t_dense"):
        if k in FIX:
            run(f"feed pterm {k}", q("images", limit=200, pterms=FIX[k]))
            run(f"ids  pterm {k}", q("images/ids", pterms=FIX[k]))
    run(
        "feed pterm rare|mid OR",
        q("images", limit=200, pterms=[FIX["t_rare"], FIX["t_mid"]], plogic="or"),
    )
    run(
        "feed pterm mid&dense AND",
        q("images", limit=200, pterms=[FIX["t_mid"], FIX["t_dense"]]),
    )

    # combined
    run(
        "feed tag dense+pterm rare",
        q("images", limit=200, tags=FIX["dense"], pterms=FIX["t_rare"]),
    )
    run(
        "feed tag mid+tag dense",
        q("images", limit=200, tags=[FIX["mid"], FIX["dense"]]),
    )
    run(
        "feed tag rare|mid OR",
        q("images", limit=200, tags=[FIX["rare"], FIX["mid"]], logic="or"),
    )
    run("feed tag mid+lib", q("images", limit=200, tags=FIX["mid"], library_id=big))
    run("feed tag rare+lib", q("images", limit=200, tags=FIX["rare"], library_id=big))
    run(
        "feed tag dense+pterm mid+lib",
        q("images", limit=200, tags=FIX["dense"], pterms=FIX["t_mid"], library_id=big),
    )
    run("ids  tag mid+tag dense", q("images/ids", tags=[FIX["mid"], FIX["dense"]]))
    run("feed no_tags=1", q("images", limit=200, no_tags=1))
    run("feed no_ai_tags=1", q("images", limit=200, no_ai_tags=1))
    run("feed ai_tagged=1", q("images", limit=200, ai_tagged=1))
    run("feed quarantined=1", q("images", limit=200, quarantined=1))
    run("feed shape=2:3", q("images", limit=200, shape="2:3"))
    run("feed min_w=1500", q("images", limit=200, min_w=1500))
    models = cli.get(q("images/models")).json()
    if models:
        m = models[0]["model"]
        run("feed model top1", q("images", limit=200, model=m))
    loras = cli.get(q("images/loras")).json()
    if loras:
        m = loras[0]["name"] if isinstance(loras[0], dict) else loras[0]
        run("feed lora top1", q("images", limit=200, lora=m))
    run("ids  all", q("images/ids"))
    run("ids  lib", q("images/ids", library_id=big))
    # search
    for s in ("00007", "png", "zzqx"):
        run(f"search q={s}", q("images/search", q=s))
    # grouped view
    run("groups first l100", q("images/groups", limit=100))
    run(
        "groups offset deep l100",
        q("images/groups", limit=100, offset=20000 if syn else 2000),
    )
    run("groups tag dense", q("images/groups", limit=100, tags=FIX["dense"]))
    run("groups tag rare", q("images/groups", limit=100, tags=FIX["rare"]))
    run("groups lib", q("images/groups", limit=100, library_id=big))


def char_and_tag():
    chars = cli.get(q("tags/characters")).json()
    top_char = chars[0]["tag"] if chars else None
    browse = cli.get(q("tags/browse")).json()
    return top_char, browse


def tags_suite():
    run("tags (ai only)", q("tags"), cold=True)
    run(
        "tags all sources",
        q("tags", include_manual="true", include_prompt="true"),
        cold=True,
    )
    run(
        "tags merged",
        q("tags", include_manual="true", include_prompt="true", merge_sources="true"),
        cold=True,
    )
    for src in ("all", "ai", "prompt", "manual"):
        run(f"tags/browse {src}", q("tags/browse", source=src), cold=True)
    run("tags/characters", q("tags/characters"), cold=True)
    top_char, browse = char_and_tag()
    if top_char:
        run("tags/character (top char)", q("tags/character", tag=top_char), cold=True)
    # a dense, a mid and a rare tag's detail and page
    by = sorted(browse, key=lambda r: -r["count"])
    picks = {
        "dense": by[0]["tag"],
        "mid": by[len(by) // 50]["tag"],
        "rare": FIX["rare"].split(":")[-1],
    }
    for k, tg in picks.items():
        run(f"tags/detail {k}", q("tags/detail", tag=tg), cold=True)
        run(f"tags/character plain {k}", q("tags/character", tag=tg), cold=True)
    names = [r["tag"] for r in by[:60]]
    run("tags/samples 60 tags", q("tags/samples", tags=names, per=4), cold=True)
    run("tags/merge-suggestions", q("tags/merge-suggestions"), cold=True)
    run("tags/descriptions", q("tags/descriptions"), cold=True)
    run("tags/danbooru-aliases", q("tags/danbooru-aliases"), cold=True)
    run("tags/attire", q("tags/attire"), cold=True)
    run("tags/facets", q("tags/facets"), cold=True)
    run("tags/groups", q("tags/groups"), cold=True)
    run("tags/board", q("tags/board"), cold=True)
    run("tags/rules", q("tags/rules"), cold=True)
    run("tags/settings", q("tags/settings"))


def misc_suite():
    run("images/stats days=371", q("images/stats", days=371, tz="UTC"), cold=True)
    run("images/sizes", q("images/sizes"), cold=True)
    run("images/models", q("images/models"), cold=True)
    run("images/loras", q("images/loras"), cold=True)
    run("images/embeddings", q("images/embeddings"), cold=True)
    run("ai/coverage", q("ai/coverage"), cold=True)
    run("activity", q("activity"))
    run("libraries", q("libraries"))
    run("onboarding", q("onboarding"))
    run("sensitivity GET", q("sensitivity"), cold=True)
    run("sensitivity/tags", q("sensitivity/tags"))
    run("rules", q("rules"))
    run("rules/signatures", q("rules/signatures"), cold=True)
    run("generate/character-names", q("generate/character-names"), cold=True)
    run("generate/outfits", q("generate/outfits"), cold=True)
    run("generate/batches", q("generate/batches"))
    run("generate/lora-words", q("generate/lora-words"), cold=True)
    top_char, _ = char_and_tag()
    if top_char:
        run(
            "generate/recipes/{top char}",
            q(f"generate/recipes/{quote(top_char, safe='')}"),
            cold=True,
        )
        run(
            "generate/outfits/default top char",
            q("generate/outfits/default", character=top_char),
            cold=True,
        )
        run(
            "generate/outfits/covers top char",
            q("generate/outfits/covers", character=top_char),
            cold=True,
        )
        run(
            "generate/outfits top char",
            q("generate/outfits", character=top_char),
            cold=True,
        )


def media_suite():
    ids = cli.get(q("images", limit=200)).json()
    iid = ids[37]["_id"]
    e = quote(iid, safe="")
    run("image detail", f"{API}/images/{e}")
    run("image workflow", f"{API}/images/{e}/workflow")
    run("image thumb-url", f"{API}/images/{e}/thumb-url")
    run("thumb GET", f"{API}/images/{e}/thumb")
    run("thumb HEAD", f"{API}/images/{e}/thumb", method="HEAD")
    run(
        "thumb GET gzip-accepting",
        f"{API}/images/{e}/thumb",
        headers={"Accept-Encoding": "gzip"},
    )
    # small: first ask builds it. Cold = distinct images never asked before.
    first = []
    for row in ids[100:130]:
        ee = quote(row["_id"], safe="")
        dt, r, n = req("GET", f"{API}/images/{ee}/thumb?size=small")
        first.append(dt)
    results.append(
        {
            "name": "small thumb GET first-ask (30 distinct)",
            "cold_p50": pct(first, 0.5),
            "cold_p95": pct(first, 0.95),
            "load": loadavg(),
        }
    )
    print(
        f"small thumb first-ask p50 {pct(first, 0.5):.1f} p95 {pct(first, 0.95):.1f}",
        flush=True,
    )
    run("small thumb GET", f"{API}/images/{e}/thumb?size=small")
    run("small thumb HEAD", f"{API}/images/{e}/thumb?size=small", method="HEAD")
    run("original GET", f"{API}/images/{e}/file")
    run("original HEAD", f"{API}/images/{e}/file", method="HEAD")
    run(
        "original Range 0-65535",
        f"{API}/images/{e}/file",
        headers={"Range": "bytes=0-65535"},
    )
    run(
        "original GET gzip-accepting",
        f"{API}/images/{e}/file",
        headers={"Accept-Encoding": "gzip"},
    )
    # 200-tile page worth of thumbs, sequential
    t0 = time.perf_counter()
    for row in ids:
        cli.get(f"{API}/images/{quote(row['_id'], safe='')}/thumb")
    dt = (time.perf_counter() - t0) * 1000
    results.append(
        {"name": "200 thumbs sequential total", "warm_p50": dt, "load": loadavg()}
    )
    print(f"200 thumbs sequential: {dt:.0f} ms", flush=True)


def sens_suite():
    r = cli.post(f"{API}/sensitivity", json={"max_level": "sensitive"})
    print("filter on:", r.status_code, r.json().get("max_level"), flush=True)
    try:
        run("SENS feed first newest", q("images", limit=200))
        total = n_pages({})
        d = 50 if args.dataset == "syn" else max(2, total // 2)
        cur, got = walk({}, d)
        if cur:
            run(f"SENS feed deep{got} newest", q("images", limit=200, cursor=cur))
        run("SENS feed first top", q("images", limit=200, sort="top"))
        run("SENS feed tag rare", q("images", limit=200, tags=FIX["rare"]))
        run("SENS feed tag mid", q("images", limit=200, tags=FIX["mid"]))
        run("SENS feed tag dense", q("images", limit=200, tags=FIX["dense"]))
        run(
            "SENS feed lib",
            q(
                "images",
                limit=200,
                library_id=cli.get(q("images", limit=1)).json()[0]["_id"].split(":")[0],
            ),
        )
        run("SENS ids all", q("images/ids"))
        run("SENS groups first", q("images/groups", limit=100))
        run(
            "SENS tags all sources",
            q("tags", include_manual="true", include_prompt="true"),
            cold=True,
        )
        run(
            "SENS tags merged",
            q(
                "tags",
                include_manual="true",
                include_prompt="true",
                merge_sources="true",
            ),
            cold=True,
        )
        run("SENS tags/browse all", q("tags/browse"), cold=True)
        run("SENS tags/characters", q("tags/characters"), cold=True)
        run("SENS images/stats", q("images/stats", days=371, tz="UTC"), cold=True)
    finally:
        r = cli.post(f"{API}/sensitivity", json={"max_level": None})
        print("filter off:", r.status_code, r.json().get("max_level"), flush=True)


{
    "feed": feed_suite,
    "tags": tags_suite,
    "misc": misc_suite,
    "media": media_suite,
    "sens": sens_suite,
}[args.suite]()

out = BENCH / "results" / f"http-{args.dataset}-{args.suite}{args.tag}.json"
out.write_text(
    json.dumps(
        {"when": time.strftime("%F %T"), "port": args.port, "results": results},
        indent=1,
    )
)
print("wrote", out)
