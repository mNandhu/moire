"""One-off dev script: build ``src/moire/data/tag_groups.json``, the tag-group list.

Walks Danbooru's ``tag_groups`` wiki hub and its ``tag_group:*`` sub-group pages
recursively (Body, Hair, Clothing, Composition, Sex, World, ...). Each tag keeps
the top-level category (the hub heading it sits under) and the group page it
came from. Tags the WD tagger can't produce (its ``selected_tags.csv``) are
dropped. Output is sorted, stable, hand-editable JSON; the attire list
(``src/moire/services/attire.py``) is its Clothing category.

Danbooru sits behind Cloudflare, so the API needs a logged-in key. Credentials
come from the environment only, never from files or arguments::

    export DANBOORU_LOGIN=... DANBOORU_API_KEY=... [DANBOORU_USER_ID=...]
    uv --directory packages/backend run python scripts/build_tag_groups.py \\
        --vocab /path/to/SmilingWolf_wd-vit-tagger-v3.csv

If the API is challenged by Cloudflare, crawl the pages from a logged-in
browser tab instead (``scripts/crawl_tag_groups.js``, pasted into the console
of a danbooru.donmai.us tab) and pass the file it downloads as
``--pages-json``. ``--from-dir <dir>`` reads one ``<title>.txt`` per page
(``/`` and ``:`` become ``_``).

Fetched pages are cached in ``--cache-dir`` (gitignored) so a re-run costs no
requests.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from moire.services.tag_names import canonical_name  # noqa: E402

BASE_URL = "https://danbooru.donmai.us"
ROOT_TITLE = "tag_groups"
GROUP_PREFIX = "tag_group:"
BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_OUT = BACKEND / "src" / "moire" / "data" / "tag_groups.json"
DEFAULT_CACHE = BACKEND / ".tag-groups-cache"

# `[[target]]`, `[[target|label]]`, `[[target#anchor|label]]`
_WIKI_LINK = re.compile(r"\[\[([^\[\]]+?)\]\]")
# `"label":[/wiki_pages/tag_group:headwear]` and the bare `:/wiki_pages/...` form
_PATH_LINK = re.compile(r"/wiki_pages/([^\s\]\)\"]+)")


class FetchError(RuntimeError):
    pass


def normalize_target(raw: str) -> str:
    """A link target in wiki-title spelling: no label or anchor, lowercase,
    underscores for spaces."""
    target = raw.split("|", 1)[0].split("#", 1)[0]
    return canonical_name(target).lower()


def extract_links(dtext: str) -> list[str]:
    """Every wiki link target in a page, normalised, in order of appearance
    and without duplicates."""
    found: list[str] = []
    for m in _WIKI_LINK.finditer(dtext):
        found.append(normalize_target(m.group(1)))
    for m in _PATH_LINK.finditer(dtext):
        found.append(normalize_target(m.group(1).replace("%3A", ":")))
    return list(dict.fromkeys(t for t in found if t))


# `h6. Body` and Danbooru's `h6#body. Body`
_HEADING = re.compile(r"^h[1-6](?:#[\w-]+)?\.\s*(.+?)\s*$")


def split_links(dtext: str) -> tuple[list[str], list[str]]:
    """``(sub_group_titles, tag_names)`` linked from a page. A link outside a
    tag group that carries a namespace (``help:``, ``howto:``, ``pool:``...) is
    not a tag and is skipped."""
    groups: list[str] = []
    tags: list[str] = []
    for target in extract_links(dtext):
        if target.startswith(GROUP_PREFIX):
            groups.append(target)
        elif ":" not in target and not target.startswith(("list_of_", "http")):
            tags.append(target)
    return groups, tags


def sections(dtext: str) -> list[tuple[str | None, str]]:
    """A page cut at its ``hN.`` headings: ``(heading, text)`` pairs, the text
    before the first heading under ``None``."""
    out: list[tuple[str | None, list[str]]] = [(None, [])]
    for line in dtext.splitlines():
        m = _HEADING.match(line)
        if m:
            out.append((m.group(1), []))
        else:
            out[-1][1].append(line)
    return [(h, "\n".join(lines)) for h, lines in out]


def category_name(heading: str) -> str:
    """A hub heading as a category key (``Hair colors`` -> ``hair_colors``)."""
    return normalize_target(re.sub(r"[^\w\s-]", "", heading))


Found = dict[str, dict[tuple[str, str], int]]


def walk(read_page, root: str = ROOT_TITLE) -> tuple[Found, list[str]]:
    """Breadth-first walk of the tag-group hierarchy from ``root``.

    ``read_page(title)`` returns a page's DText, or ``None`` when it doesn't
    exist. A sub-group linked under a heading of the root page takes that
    heading as its category, and passes it down to its own sub-groups. Returns
    ``({tag: {(category, group): depth}}, missing_pages)``: every place a tag
    was found, with how deep that group sits (the root is depth 0).
    """
    found: Found = defaultdict(dict)
    missing: list[str] = []
    visited = {root}
    queue: list[tuple[str, int, str | None]] = [(root, 0, None)]
    while queue:
        title, depth, inherited = queue.pop(0)
        body = read_page(title)
        if body is None:
            missing.append(title)
            continue
        group = title.removeprefix(GROUP_PREFIX)
        for heading, text in sections(body):
            named = inherited or (category_name(heading) if heading else None)
            category = named or group
            # Tags listed on the hub itself have no page of their own.
            group = category if title == root else group
            sub_groups, tags = split_links(text)
            for tag in tags:
                found[tag].setdefault((category, group), depth)
            for sub in sub_groups:
                if sub not in visited:
                    visited.add(sub)
                    # Without a hub heading, a group page names its own category.
                    queue.append((sub, depth + 1, named))
    return dict(found), missing


def pick_place(places: dict[tuple[str, str], int], sizes: dict[tuple[str, str], int]):
    """The primary ``(category, group)`` of a tag found under several: the
    smallest group (``hat`` is headwear, not the broad accessories list), ties
    broken by depth then name so the result is stable."""
    return min(places, key=lambda p: (sizes[p], -places[p], p))


def load_vocab(csv_path: Path) -> set[str]:
    """General-tag names (category 0) of a WD ``selected_tags.csv``, in the
    stored canonical spelling."""
    with csv_path.open(encoding="utf-8", newline="") as f:
        return {
            canonical_name(row["name"]).lower()
            for row in csv.DictReader(f)
            if row.get("category") == "0"
        }


def build(
    found: Found, vocab: set[str]
) -> tuple[dict[str, dict], list[str], dict[str, list[str]]]:
    """``(tags, dropped, ambiguous)``: the kept ``tag -> {category, group, also}``
    map (sorted; ``also`` lists the other ``category/group`` places, left out
    when there are none), the found tags the tagger can't produce, and the kept
    tags that sit under more than one place."""
    kept = {tag: places for tag, places in found.items() if tag in vocab}
    sizes: dict[tuple[str, str], int] = defaultdict(int)
    for places in kept.values():
        for place in places:
            sizes[place] += 1
    tags: dict[str, dict] = {}
    ambiguous: dict[str, list[str]] = {}
    for tag in sorted(kept):
        places = kept[tag]
        category, group = pick_place(places, sizes)
        info: dict = {"category": category, "group": group}
        others = sorted(f"{c}/{g}" for c, g in places if (c, g) != (category, group))
        if others:
            info["also"] = others
            ambiguous[tag] = sorted(f"{c}/{g}" for c, g in places)
        tags[tag] = info
    dropped = sorted(tag for tag in found if tag not in vocab)
    return tags, dropped, ambiguous


def _slug(title: str) -> str:
    return re.sub(r"[/:]", "_", title)


class Source:
    """Page reader: local files, else the on-disk cache, else the API."""

    def __init__(
        self,
        cache_dir: Path,
        from_dir: Path | None,
        delay: float,
        pages: dict[str, str] | None = None,
    ):
        self.cache_dir = cache_dir
        self.from_dir = from_dir
        self.pages = pages
        self.delay = delay
        self._client = None

    def read(self, title: str) -> str | None:
        if self.pages is not None:
            return self.pages.get(title)
        if self.from_dir is not None:
            path = self.from_dir / f"{_slug(title)}.txt"
            return path.read_text(encoding="utf-8") if path.exists() else None
        cached = self.cache_dir / f"{_slug(title)}.json"
        if cached.exists():
            return json.loads(cached.read_text(encoding="utf-8"))["body"]
        body = self._fetch(title)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps({"title": title, "body": body}), encoding="utf-8")
        return body

    def _fetch(self, title: str) -> str | None:
        import httpx

        login, key = (
            os.environ.get("DANBOORU_LOGIN"),
            os.environ.get("DANBOORU_API_KEY"),
        )
        if not (login and key):
            raise FetchError(
                "set DANBOORU_LOGIN and DANBOORU_API_KEY (or use --from-dir)"
            )
        if self._client is None:
            # Danbooru asks bots to identify with a unique agent carrying the
            # user id (`DANBOORU_USER_ID`; the login name stands in without it).
            who = os.environ.get("DANBOORU_USER_ID")
            agent = (
                f"moire-tag-groups/1.0 (user #{who})"
                if who
                else f"moire-tag-groups/1.0 (user {login})"
            )
            self._client = httpx.Client(
                headers={"User-Agent": agent},
                auth=(login, key),
                timeout=30.0,
                follow_redirects=True,
            )
        time.sleep(self.delay)
        r = self._client.get(
            f"{BASE_URL}/wiki_pages.json",
            params={
                "search[title]": title,
                "only": "title,body",
                "limit": 1,
            },
        )
        if r.status_code in (403, 503) or "json" not in r.headers.get(
            "content-type", ""
        ):
            raise FetchError(
                f"{title}: HTTP {r.status_code}, looks like a Cloudflare challenge "
                "(save the pages and use --from-dir)"
            )
        r.raise_for_status()
        pages = r.json()
        return pages[0]["body"] if pages else None


def main() -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("--vocab", type=Path, required=True, help="WD selected_tags.csv")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--from-dir", type=Path, help="read saved DText files, no network")
    ap.add_argument(
        "--pages-json", type=Path, help="{title: dtext} from the browser crawl"
    )
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    args = ap.parse_args()

    pages = (
        json.loads(args.pages_json.read_text(encoding="utf-8"))
        if args.pages_json
        else None
    )
    source = Source(args.cache_dir, args.from_dir, args.delay, pages)
    try:
        found, missing = walk(source.read)
    except FetchError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if ROOT_TITLE in missing:
        print(f"error: {ROOT_TITLE} not found", file=sys.stderr)
        return 1

    tags, dropped, ambiguous = build(found, load_vocab(args.vocab))
    doc = {
        "source": f"{BASE_URL}/wiki_pages/{ROOT_TITLE}",
        "built": datetime.date.today().isoformat(),
        "tags": tags,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    per_group: dict[str, int] = defaultdict(int)
    for info in tags.values():
        per_group[f"{info['category']}/{info['group']}"] += 1
    print(f"wrote {len(tags)} tags to {args.out}")
    for place, n in sorted(per_group.items()):
        print(f"  {place}: {n}")
    print(f"dropped (not in tagger vocab): {len(dropped)}")
    print(f"in several groups: {len(ambiguous)}")
    for tag, places in ambiguous.items():
        print(
            f"  {tag}: {', '.join(places)} -> {tags[tag]['category']}/{tags[tag]['group']}"
        )
    if missing:
        print(f"missing pages: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
