"""One-off dev script: a one-sentence description for every tag in the library.

Each tag is looked up (through Danbooru's aliases, so ``absolute_territory``
finds ``zettai_ryouiki``) in a dump of Danbooru's wiki. A wiki body is cleaned
of DText and handed to an LLM to condense; a tag with
no wiki page is described from its name alone. The model answers through a
JSON schema with ``known``, a 1-5 ``confidence`` and a ``kind`` (visual, quality,
meta, abstract, junk) per tag, so weak guesses and non-visual words
can be culled later. Artist and character tags are skipped.

Every row records its ``source``:

- ``wiki``: grounded in the tag's wiki page.
- ``name``: a real Danbooru tag (or WD vocab name) without a wiki page.
- ``unknown``: neither; mostly prompt-only words and typos.
- ``canary``: a made-up tag mixed into the run to check the model says so.
- ``control``: a wiki tag sent without its wiki, to compare against ``wiki``.

The wiki dump is the HF dataset ``dartags/danbooru-wiki-2609`` (one parquet
file), read with pyarrow, which the app doesn't need, hence ``--with``::

    export LLM_BASE_URL=https://example.com/v1   # optional: LLM_API_KEY, LLM_MODEL
    uv --directory packages/backend run --with pyarrow \\
        python scripts/build_tag_descriptions.py \\
        --db ../../data/moire.db \\
        --wiki .tag-desc-cache/danbooru-wiki-2609.parquet \\
        --tag-list ../../.cache/moire/models/danbooru/danbooru-tags.csv \\
        --vocab ../../.cache/moire/models/SmilingWolf_wd-vit-tagger-v3.csv

    ... build_tag_descriptions.py --report   # confidence per source, samples

Any OpenAI-compatible chat completions server works if it honours
``response_format: json_schema`` (structured output). Its address and key
come from the environment only; ``LLM_MODEL`` defaults to the first model the
server lists.

Results append to ``--out`` (JSONL, gitignored cache dir), one row per tag, so
a re-run only asks for what is missing.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import csv
import json
import os
import random
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from moire.services import danbooru_tags  # noqa: E402

CACHE = Path(__file__).resolve().parents[1] / ".tag-desc-cache"
EXPORT = Path(__file__).resolve().parents[1] / "src/moire/data/tag_descriptions.json"
SKIP_CATEGORIES = {danbooru_tags.ARTIST, danbooru_tags.CHARACTER}
WIKI_SKIP = {"artist", "character"}
WIKI_CHARS = 600
WIKI_BATCH = 20
NAME_BATCH = 30
# Requests in flight. A server that batches requests gets faster with more,
# up to where its KV cache fills; raise it with --concurrency to suit.
CONCURRENCY = 8
CONTROLS = 20

# Plausible-looking tags that don't exist; the model should not know them.
CANARIES = [
    "glorbnax_hair",
    "triple_moon_sleeves",
    "velkin_pose",
    "skirt_inversion_ribbon",
    "frosted_elbow_gaze",
    "quadruple_ahoge_braid",
    "umbral_kneesocks",
    "drift_collar",
    "shimmer_tail_grip",
    "hollow_bangs_twist",
    "marrow_eyes",
    "sideways_halo_cut",
    "petal_lantern_stance",
    "crescent_bootlace",
    "inverted_twintail_loop",
    "zephyr_sash",
    "ribbon_echo",
    "cloudbound_shoulders",
    "vexil_mark",
    "nimbus_cuffs",
]

KINDS = ("visual", "quality", "meta", "abstract", "junk")

SYSTEM = """You write tag descriptions for an image organizer that uses Danbooru-style tags.
For each tag, write ONE plain sentence (at most 25 words) saying what the tag shows in an image.
Rules:
- If a wiki excerpt is given, base the sentence on it and nothing else.
- Describe what is visible. No "this tag", no "used for", no examples, no trivia.
- Explicit or sexual tags get a plain, factual, non-graphic description.
- Never use em dashes or en dashes.
- known: false if you do not recognize the tag as a real, established term; then description is "".
- confidence (1-5): 5 certain (or wiki given), 4 confident, 3 plausible guess, 2 weak guess, 1 no idea.
  Be honest: a made-up or ambiguous name gets 1 or 2, not a guess dressed as a fact.
- kind: "visual" if it names something you can see in the image (subject, body, clothing,
  pose, expression, object, setting, composition, lighting, art style);
  "quality" for quality or score boosters (masterpiece, best_quality, score_9, highly_detailed);
  "meta" for facts about the file or post rather than its content (highres, photo_(medium) is visual);
  "abstract" for a mood, concept or adjective with no clear visual meaning;
  "junk" for fragments, typos, settings or code that slipped into a prompt.
Return one item per input tag, echoing the tag exactly."""

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tag": {"type": "string"},
                    "known": {"type": "boolean"},
                    "confidence": {"type": "integer", "minimum": 1, "maximum": 5},
                    "description": {"type": "string"},
                    "kind": {"enum": list(KINDS)},
                },
                "required": ["tag", "known", "confidence", "description", "kind"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


# --- wiki -------------------------------------------------------------------

_SECTION = re.compile(r"\n\s*h[1-6]\.")
_POST = re.compile(r"^\s*\*?\s*!(post|asset) #\d+.*$", re.M)
_LINK_PIPE = re.compile(r"\[\[([^\]|]+)\|([^\]]*)\]\]")
_LINK = re.compile(r"\[\[([^\]]+)\]\]")
_TAG_SEARCH = re.compile(r"\{\{([^}]+)\}\}")
_URL_LINK = re.compile(r'"([^"]+)":\[?(https?://\S+?|/\S+?)\]?(?=[\s.,)]|$)')
_BB = re.compile(r"\[/?(b|i|u|s|tn|spoiler|expand|quote|code|nodtext)[^\]]*\]", re.I)
_WS = re.compile(r"\s+")


def _unwrap(body: str) -> str:
    """The dump stores some bodies as a Python repr (``'text\\r\\n'``)."""
    b = body.strip()
    if len(b) >= 2 and b[0] == b[-1] and b[0] in "'\"":
        try:
            v = ast.literal_eval(b)
            if isinstance(v, str):
                return v
        except (ValueError, SyntaxError):
            pass
    return b


def _pipe(m: re.Match) -> str:
    target, label = m.group(1), m.group(2)
    if label:
        return label
    # [[poster (object)|]] shows as "poster".
    return re.sub(r"\s*\([^)]*\)$", "", target)


def clean_wiki(body: str) -> str:
    """The wiki's lead paragraph(s) as plain text, capped."""
    s = _unwrap(body).replace("\r\n", "\n")
    m = _SECTION.search("\n" + s)
    if m and m.start() > 0:
        s = s[: m.start() - 1]
    s = _POST.sub("", s)
    s = _LINK_PIPE.sub(_pipe, s)
    s = _LINK.sub(lambda m: m.group(1), s)
    s = _TAG_SEARCH.sub(lambda m: m.group(1), s)
    s = _URL_LINK.sub(lambda m: m.group(1), s)
    s = _BB.sub("", s)
    s = _WS.sub(" ", s).strip()
    if len(s) > WIKI_CHARS:
        cut = s.rfind(". ", 0, WIKI_CHARS)
        s = s[: cut + 1] if cut > WIKI_CHARS // 2 else s[:WIKI_CHARS] + "..."
    return s


def load_wiki(path: Path) -> dict[str, dict]:
    """``title -> {category, body}``."""
    import pyarrow.parquet as pq

    cols = ["title", "body", "category", "is_deleted"]
    pages: dict[str, dict] = {}
    for r in pq.read_table(path, columns=cols).to_pylist():
        if r["is_deleted"] or not r["title"]:
            continue
        pages[r["title"].lower()] = {
            "category": r["category"] or "",
            "body": r["body"] or "",
        }
    return pages


# --- tags -------------------------------------------------------------------


def library_tags(db: Path) -> list[str]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return [r[0] for r in con.execute("SELECT DISTINCT base FROM image_tags")]
    finally:
        con.close()


def vocab_names(path: Path) -> set[str]:
    """The WD tagger's general tags (not its characters or ratings)."""
    with open(path, encoding="utf-8") as f:
        return {
            r["name"].lower()
            for r in csv.DictReader(f)
            if r.get("name") and r.get("category") == "0"
        }


def worth_asking(tag: str) -> bool:
    """Lora tokens and names with no letters aren't tags to describe."""
    return not tag.startswith("<") and any(c.isalpha() for c in tag) and len(tag) <= 80


def plan(tags, tag_list, pages, vocab) -> list[dict]:
    """One job per tag: what to look up, where it came from, the wiki text."""
    jobs = []
    for tag in sorted(set(tags)):
        if not worth_asking(tag):
            continue
        key = tag.lower()
        name = tag_list.resolve(key)
        category, posts = tag_list.tags.get(name, (None, 0))
        if category in SKIP_CATEGORIES:
            continue
        # Only Danbooru's own aliases redirect: a wiki's "other names" are
        # loose (``slim`` is a JAXA lunar lander, ``lust`` an eroge).
        page_title = name if name in pages else None
        via = "direct" if name == key else "alias"
        page = pages.get(page_title) if page_title else None
        if page and page["category"] in WIKI_SKIP:
            continue
        text = clean_wiki(page["body"]) if page else ""
        if text:
            source = "wiki"
        elif category is not None or key in vocab:
            source = "name"
        else:
            source = "unknown"
        jobs.append(
            {
                "tag": tag,
                "lookup": page_title or name,
                "via": via if text else "",
                "source": source,
                "category": category,
                "posts": posts,
                "wiki": text,
            }
        )
    return jobs


def with_checks(jobs: list[dict], rng: random.Random) -> list[dict]:
    """Add the canaries and the no-wiki controls."""
    out = list(jobs)
    out += [
        {
            "tag": c,
            "lookup": c,
            "via": "",
            "source": "canary",
            "category": None,
            "posts": 0,
            "wiki": "",
        }
        for c in CANARIES
    ]
    wiki = [j for j in jobs if j["source"] == "wiki"]
    for j in rng.sample(wiki, min(CONTROLS, len(wiki))):
        out.append({**j, "source": "control", "via": "", "wiki": ""})
    return out


def row_key(row: dict) -> str:
    return f"{row['source'] == 'control' and 'control:' or ''}{row['tag']}"


# --- LLM --------------------------------------------------------------------


class Endpoint:
    def __init__(self) -> None:
        url = os.environ.get("LLM_BASE_URL", "").rstrip("/")
        if not url:
            raise SystemExit(
                "set LLM_BASE_URL to the server's OpenAI-compatible base URL (…/v1)"
            )
        headers = {}
        if key := os.environ.get("LLM_API_KEY"):
            headers["Authorization"] = f"Bearer {key}"
        self.url = url
        self.client = httpx.AsyncClient(headers=headers, timeout=180)
        self.model = os.environ.get("LLM_MODEL", "")

    async def resolve_model(self) -> str:
        if not self.model:
            r = await self.client.get(f"{self.url}/models")
            r.raise_for_status()
            self.model = r.json()["data"][0]["id"]
        return self.model

    async def describe(self, batch: list[dict]) -> list[dict]:
        lines = []
        for j in batch:
            item = {"tag": j["tag"]}
            if j["wiki"]:
                item["wiki"] = j["wiki"]
            lines.append(item)
        body = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": 90 * len(batch) + 200,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": json.dumps(lines, ensure_ascii=False)},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "tag_descriptions",
                    "schema": SCHEMA,
                    "strict": True,
                },
            },
        }
        for attempt in range(3):
            try:
                r = await self.client.post(f"{self.url}/chat/completions", json=body)
                r.raise_for_status()
                content = r.json()["choices"][0]["message"]["content"]
                return json.loads(content)["items"]
            except (httpx.HTTPError, KeyError, ValueError) as e:
                if attempt == 2:
                    print(f"  batch of {len(batch)} failed: {e!r}", file=sys.stderr)
                    return []
                await asyncio.sleep(2 * (attempt + 1))
        return []


_DASH = re.compile(r"\s*[\u2014\u2013]\s*")


def tidy(text: str) -> str:
    return _DASH.sub(", ", text).strip()


async def run_batch(ep: Endpoint, batch: list[dict], sink) -> None:
    """Ask, keep the items whose tag came back intact, re-split on misses."""
    items = await ep.describe(batch)
    by_tag = {i.get("tag"): i for i in items if isinstance(i, dict)}
    missed = []
    for j in batch:
        i = by_tag.get(j["tag"])
        # Whole batches sometimes come back all "unknown" at confidence 5, wiki
        # excerpt and all; an answer that contradicts itself is asked again
        # in a smaller batch (a lone tag keeps what it got).
        if (
            i is not None
            and not i["known"]
            and len(batch) > 1
            and (j["wiki"] or i["confidence"] >= 3)
        ):
            i = None
        if i is None:
            missed.append(j)
            continue
        known = bool(i["known"])
        sink(
            {
                "tag": j["tag"],
                "lookup": j["lookup"],
                "via": j["via"],
                "source": j["source"],
                "category": j["category"],
                "posts": j["posts"],
                "known": known,
                "confidence": int(i["confidence"]),
                "kind": i["kind"],
                "description": tidy(i["description"]) if known else "",
                "wiki_chars": len(j["wiki"]),
                "model": ep.model,
            }
        )
    if missed and len(batch) > 1:
        mid = (len(missed) + 1) // 2
        await asyncio.gather(
            run_batch(ep, missed[:mid], sink), run_batch(ep, missed[mid:], sink)
        )
    elif missed:
        print(f"  gave up on {missed[0]['tag']!r}", file=sys.stderr)


async def generate(jobs: list[dict], out: Path, concurrency: int) -> None:
    done = set()
    if out.exists():
        with open(out, encoding="utf-8") as f:
            done = {row_key(json.loads(line)) for line in f if line.strip()}
    todo = [j for j in jobs if row_key(j) not in done]
    print(f"{len(jobs)} tags, {len(done)} done, {len(todo)} to ask")
    if not todo:
        return
    ep = Endpoint()
    print(f"model: {await ep.resolve_model()}")

    batches = []
    for has_wiki, size in ((True, WIKI_BATCH), (False, NAME_BATCH)):
        group = [j for j in todo if bool(j["wiki"]) == has_wiki]
        batches += [group[i : i + size] for i in range(0, len(group), size)]
    random.Random(0).shuffle(batches)

    out.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with open(out, "a", encoding="utf-8") as f:

        def sink(row: dict) -> None:
            nonlocal count
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            count += 1

        sem = asyncio.Semaphore(concurrency)

        async def one(b: list[dict]) -> None:
            async with sem:
                await run_batch(ep, b, sink)
                print(f"  {count}/{len(todo)}", end="\r", flush=True)

        await asyncio.gather(*(one(b) for b in batches))
    await ep.client.aclose()
    print(f"\nwrote {count} rows to {out}")


# --- report -----------------------------------------------------------------


def report(out: Path, samples: int) -> None:
    rows = [json.loads(line) for line in open(out, encoding="utf-8") if line.strip()]
    by_source = defaultdict(list)
    for r in rows:
        by_source[r["source"]].append(r)
    print(f"{len(rows)} rows\n")
    print(
        f"{'source':<9} {'n':>5}  unknown  "
        + "  ".join(f"c{c}".rjust(5) for c in range(1, 6))
    )
    for source in ("wiki", "name", "unknown", "control", "canary"):
        rs = by_source.get(source, [])
        if not rs:
            continue
        hist = Counter(r["confidence"] for r in rs)
        unk = sum(not r["known"] for r in rs)
        print(
            f"{source:<9} {len(rs):>5}  {unk:>7}  "
            + "  ".join(str(hist[c]).rjust(5) for c in range(1, 6))
        )

    print(f"\n{'source':<9} " + " ".join(k.rjust(8) for k in KINDS) + "   (known only)")
    for source in ("wiki", "name", "unknown", "control", "canary"):
        kinds = Counter(r["kind"] for r in by_source.get(source, []) if r["known"])
        if kinds:
            print(f"{source:<9} " + " ".join(str(kinds[k]).rjust(8) for k in KINDS))

    rng = random.Random(1)
    for source in ("wiki", "name", "unknown", "canary"):
        rs = by_source.get(source, [])
        print(f"\n== {source} ({min(samples, len(rs))} of {len(rs)})")
        for r in sorted(
            rng.sample(rs, min(samples, len(rs))), key=lambda r: -r["confidence"]
        ):
            flag = "" if r["known"] else " [unknown]"
            print(
                f"  c{r['confidence']} {r['kind']:<8} {r['tag']}{flag}: {r['description']}"
            )

    redirected = [r for r in by_source.get("wiki", []) if r["via"] != "direct"]
    print(
        f"\n== wiki via alias / other name ({min(samples, len(redirected))} of {len(redirected)})"
    )
    for r in rng.sample(redirected, min(samples, len(redirected))):
        print(f"  {r['tag']} -> {r['lookup']} ({r['via']}): {r['description']}")

    wiki = {r["tag"]: r for r in by_source.get("wiki", [])}
    print("\n== control (no wiki) vs wiki")
    for r in by_source.get("control", []):
        w = wiki.get(r["tag"])
        print(
            f"  {r['tag']}\n    name c{r['confidence']}: {r['description'] or '[unknown]'}"
        )
        if w:
            print(f"    wiki c{w['confidence']}: {w['description']}")


def keep(row: dict) -> bool:
    """Whether a description ships: the model knew the tag, was sure of it
    (4 or 5), and it isn't prompt junk. Canaries and controls never ship."""
    return (
        row["source"] not in ("canary", "control")
        and row["known"]
        and row["confidence"] >= 4
        and row["kind"] != "junk"
        and bool(row["description"])
    )


def export(out: Path, dest: Path) -> None:
    rows = [json.loads(line) for line in open(out, encoding="utf-8") if line.strip()]
    kept = {r["tag"].lower(): r["description"] for r in rows if keep(r)}
    doc = {
        "about": "Built by scripts/build_tag_descriptions.py from Danbooru's wiki "
        "(dartags/danbooru-wiki-2609), condensed by an LLM.",
        "descriptions": dict(sorted(kept.items())),
    }
    dest.write_text(
        json.dumps(doc, ensure_ascii=False, indent=0) + "\n", encoding="utf-8"
    )
    print(f"{len(kept)} of {len(rows)} rows -> {dest}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--db", type=Path, help="moire.db to read the library's tags from (read-only)"
    )
    ap.add_argument("--wiki", type=Path, default=CACHE / "danbooru-wiki-2609.parquet")
    ap.add_argument(
        "--tag-list", type=Path, help="Danbooru autocomplete CSV (aliases, categories)"
    )
    ap.add_argument("--vocab", type=Path, help="WD tagger selected_tags.csv")
    ap.add_argument("--out", type=Path, default=CACHE / "descriptions.jsonl")
    ap.add_argument(
        "--limit", type=int, default=0, help="only N random tags (a trial run)"
    )
    ap.add_argument(
        "--concurrency", type=int, default=CONCURRENCY, help="requests in flight"
    )
    ap.add_argument(
        "--report", action="store_true", help="summarize --out instead of generating"
    )
    ap.add_argument("--samples", type=int, default=30)
    ap.add_argument(
        "--from",
        dest="source",
        choices=("vocab", "library"),
        default="vocab",
        help="describe the WD vocab's general tags (shipped) or the library's tags",
    )
    ap.add_argument(
        "--export",
        type=Path,
        help=f"write the kept rows of --out as the shipped JSON (default {EXPORT})",
        nargs="?",
        const=EXPORT,
    )
    args = ap.parse_args()

    if args.report:
        report(args.out, args.samples)
        return
    if args.export:
        export(args.out, args.export)
        return
    if not args.tag_list or not args.vocab:
        ap.error("--tag-list and --vocab are required to generate")
    if args.source == "library" and not args.db:
        ap.error("--from library needs --db")

    with open(args.tag_list, encoding="utf-8") as f:
        tag_list = danbooru_tags.parse(f)
    pages = load_wiki(args.wiki)
    vocab = vocab_names(args.vocab)
    tags = library_tags(args.db) if args.source == "library" else sorted(vocab)
    jobs = plan(tags, tag_list, pages, vocab)
    rng = random.Random(0)
    if args.limit:
        jobs = rng.sample(jobs, min(args.limit, len(jobs)))
    print(
        f"{args.source}: {len(tags)} tags -> {len(jobs)} to describe "
        f"({dict(Counter(j['source'] for j in jobs))})"
    )
    asyncio.run(generate(with_checks(jobs, rng), args.out, args.concurrency))


if __name__ == "__main__":
    main()
