"""Dev script: make the cover images for the starter outfits.

The starter outfits (``src/moire/data/starter_outfits.json``) ship with one
cover each (``src/moire/data/starter_outfits/<id>.webp``). The covers are made
with a running Moiré's own Generate, so they go through whatever ComfyUI that
Moiré is connected to, and land in its library like any other batch.

Every cover prompt is checked before anything is queued: the outfit's tags
must be attire and every tag sent must be general level, so nothing sensitive
ever reaches the ComfyUI (which may be a public one).

Steps (from the repo root; ``node scripts/uv-backend.mjs run`` keeps the GPU
tagger build, and paths are relative to ``packages/backend``)::

    S="node scripts/uv-backend.mjs run python scripts/starter_outfit_covers.py"
    $S check                                # validate the outfit file, queue nothing
    $S queue --base "<quality tags>"        # one batch of candidates per outfit
    $S status                               # how far the batches are
    $S sheet                                # contact sheet: pick one cover per outfit
    $S export --picks <downloaded picks.json>   # write the chosen covers

``queue`` skips outfits it queued before (``--redo id,...`` queues them again
with a new seed). Its record and the sheet live in ``--work`` (default
``.cache/starter-covers`` at the repo root, gitignored). Model, quality tags,
negative prompt and size are the caller's: nothing about one setup is kept
here.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from moire.services.characters import attire
from moire.services.tags import sensitivity
from moire.services.tags.names import canonical_name

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parents[1]
DATA = BACKEND / "src" / "moire" / "data"
OUTFITS = DATA / "starter_outfits.json"
COVERS = DATA / "starter_outfits"

# Same framing on every cover, so the picker reads as one set even though the
# wearer and backdrop change with the outfit.
FRAMING = ["solo", "full_body", "standing", "looking_at_viewer"]
# Cover size as shipped: portrait, the outfit tile's shape.
COVER_W, COVER_H = 384, 576
COVER_QUALITY = 82


# -- outfit file -------------------------------------------------------------


def split_tags(value: str | list[str]) -> list[str]:
    items = value.split(",") if isinstance(value, str) else value
    return [x.strip() for x in items if x and x.strip()]


def load_outfits() -> list[dict[str, Any]]:
    return json.loads(OUTFITS.read_text(encoding="utf-8"))["outfits"]


def prompt_tags(o: dict[str, Any]) -> list[str]:
    """What one cover asks for, after the caller's base: wearer, outfit,
    framing, backdrop."""
    return [*o["wearer"], *o["tags"], *FRAMING, *split_tags(o.get("backdrop", ""))]


def problems(o: dict[str, Any]) -> list[str]:
    """Why an outfit can't be queued (empty when it can)."""
    out = []
    for tag in o["tags"]:
        if canonical_name(tag) != tag:
            out.append(f"{tag!r} is not canonical")
        elif not attire.is_attire(tag):
            out.append(f"{tag} is not attire")
    level = sensitivity.tag_level(prompt_tags(o))
    if level:
        out.append(f"prompt is {sensitivity.level_name(level)}, not general")
    return out


def checked(only: set[str] | None = None) -> list[dict[str, Any]]:
    """The outfits to work on; exits when any of them fails its check."""
    outfits = [o for o in load_outfits() if not only or o["id"] in only]
    if only and len(outfits) != len(only):
        sys.exit(f"unknown outfit ids: {sorted(only - {o['id'] for o in outfits})}")
    bad = {o["id"]: p for o in outfits if (p := problems(o))}
    for oid, p in bad.items():
        print(f"{oid}: {'; '.join(p)}", file=sys.stderr)
    if bad:
        sys.exit(f"{len(bad)} outfit(s) failed the check; nothing queued")
    return outfits


# -- Moiré API ----------------------------------------------------------------


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def url(self, path: str) -> str:
        return path if path.startswith("http") else f"{self.base}{path}"

    def call(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.url(path),
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {path}: {e.code} {e.read().decode(errors='replace')}")
        except urllib.error.URLError as e:
            sys.exit(f"can't reach Moiré at {self.base}: {e.reason}")

    def raw(self, path: str) -> bytes:
        with urllib.request.urlopen(self.url(path), timeout=120) as resp:
            return resp.read()


def image_path(image_id: str, what: str) -> str:
    return f"/api/v1/images/{urllib.parse.quote(image_id, safe='/:')}/{what}"


# -- work record ----------------------------------------------------------------


def load_state(work: Path) -> dict[str, Any]:
    f = work / "state.json"
    return json.loads(f.read_text()) if f.exists() else {}


def save_state(work: Path, state: dict[str, Any]) -> None:
    work.mkdir(parents=True, exist_ok=True)
    (work / "state.json").write_text(json.dumps(state, indent=2, sort_keys=True))


def seed_for(outfit_id: str, attempt: int) -> int:
    digest = hashlib.sha256(f"{outfit_id}:{attempt}".encode()).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


# -- commands -------------------------------------------------------------------


def cmd_check(args: argparse.Namespace) -> None:
    outfits = checked()
    print(f"{len(outfits)} outfits pass")


def cmd_queue(args: argparse.Namespace) -> None:
    api, work = Api(args.api), Path(args.work)
    redo = set(filter(None, (args.redo or "").split(",")))
    only = set(filter(None, (args.only or "").split(","))) | redo or None
    state = load_state(work)
    queued = 0
    for o in checked(only):
        prev = state.get(o["id"])
        if prev and o["id"] not in redo:
            continue
        attempt = (prev or {}).get("attempt", -1) + 1
        seed = seed_for(o["id"], attempt)
        body: dict[str, Any] = {
            "generator_id": args.generator,
            "base": args.base,
            "extra": prompt_tags(o),
            "negative_base": args.negative,
            "seed": {"mode": "fixed", "value": seed},
            "count": args.count,
            "name": f"Starter cover: {o['name']}",
        }
        for key in ("checkpoint", "width", "height"):
            if getattr(args, key) is not None:
                body[key] = getattr(args, key)
        if args.dry_run:
            print(json.dumps(body))
            continue
        batch = api.call("POST", "/api/v1/generate/batches", body)
        state[o["id"]] = {"batch": batch["_id"], "seed": seed, "attempt": attempt}
        save_state(work, state)
        queued += 1
        print(f"{o['id']}: batch {batch['_id']}")
    print(f"queued {queued} batch(es)")


def candidates(api: Api, batch_id: int) -> tuple[str, list[dict[str, Any]]]:
    batch = api.call("GET", f"/api/v1/generate/batches/{batch_id}")
    outs = [
        x
        for q in batch["requests"]
        for x in q["outputs"]
        if x["in_library"] and not x["quarantined"]
    ]
    return batch["state"], outs


def cmd_status(args: argparse.Namespace) -> None:
    api, state = Api(args.api), load_state(Path(args.work))
    if not state:
        sys.exit("nothing queued yet")
    by_state: dict[str, int] = {}
    for o in load_outfits():
        rec = state.get(o["id"])
        if rec is None:
            print(f"{o['id']}: not queued")
            continue
        st, outs = candidates(api, rec["batch"])
        by_state[st] = by_state.get(st, 0) + 1
        print(f"{o['id']}: batch {rec['batch']} {st}, {len(outs)} in library")
    print(by_state)


SHEET_STYLE = """
body{font:14px system-ui,sans-serif;background:#111;color:#ddd;margin:16px}
h1{font-size:18px}section{margin:0 0 20px}h2{font-size:15px;margin:0 0 2px}
.tags{color:#888;font-size:12px;margin:0 0 6px}.row{display:flex;gap:8px;flex-wrap:wrap}
img{height:240px;border:3px solid transparent;border-radius:6px;cursor:pointer}
img.picked{border-color:#5ad}.miss{color:#a66}
#bar{position:sticky;top:0;background:#111;padding:8px 0;display:flex;gap:12px;align-items:center}
button{font:inherit;padding:6px 12px}
"""

SHEET_SCRIPT = """
const picks = JSON.parse(document.getElementById('picks').textContent);
function mark(){document.querySelectorAll('img').forEach(i=>
  i.classList.toggle('picked', picks[i.dataset.outfit]===i.dataset.image));
  document.getElementById('count').textContent=Object.keys(picks).length;}
document.addEventListener('click',e=>{const i=e.target.closest('img');if(!i)return;
  picks[i.dataset.outfit]=i.dataset.image;mark();});
document.getElementById('save').onclick=()=>{const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(picks,null,2)],{type:'application/json'}));
  a.download='picks.json';a.click();};
mark();
"""


def cmd_sheet(args: argparse.Namespace) -> None:
    api, work = Api(args.api), Path(args.work)
    state = load_state(work)
    picks_file = Path(args.picks) if args.picks else work / "picks.json"
    picks = json.loads(picks_file.read_text()) if picks_file.exists() else {}
    parts = []
    for o in load_outfits():
        rec = state.get(o["id"])
        head = (
            f"<h2>{html.escape(o['name'])} <small>({html.escape(o['id'])})</small></h2>"
            f"<p class=tags>{html.escape(', '.join(o['tags']))}</p>"
        )
        if rec is None:
            parts.append(f"<section>{head}<p class=miss>not queued</p></section>")
            continue
        st, outs = candidates(api, rec["batch"])
        imgs = (
            "".join(
                f"<img loading=lazy data-outfit='{html.escape(o['id'])}' "
                f"data-image='{html.escape(x['image_id'])}' src='{html.escape(api.url(x['thumb_url']))}'>"
                for x in outs
                if x.get("thumb_url")
            )
            or f"<p class=miss>{html.escape(st)}, no images yet</p>"
        )
        parts.append(f"<section>{head}<div class=row>{imgs}</div></section>")
    page = (
        "<!doctype html><meta charset=utf-8><title>Starter covers</title>"
        f"<style>{SHEET_STYLE}</style>"
        "<div id=bar><h1>Starter covers</h1><span><b id=count>0</b> picked</span>"
        "<button id=save>Download picks.json</button></div>"
        f"{''.join(parts)}"
        f"<script type=application/json id=picks>{json.dumps(picks)}</script>"
        f"<script>{SHEET_SCRIPT}</script>"
    )
    work.mkdir(parents=True, exist_ok=True)
    out = work / "sheet.html"
    out.write_text(page, encoding="utf-8")
    print(f"open {out} (with Moiré running), pick, download picks.json, then export")


def cover_bytes(raw: bytes) -> bytes:
    """Center-crop to the cover's shape, resize, WebP."""
    from PIL import Image

    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    want = COVER_W / COVER_H
    if w / h > want:
        cw = round(h * want)
        im = im.crop(((w - cw) // 2, 0, (w - cw) // 2 + cw, h))
    else:
        ch = round(w / want)
        im = im.crop((0, (h - ch) // 2, w, (h - ch) // 2 + ch))
    im = im.resize((COVER_W, COVER_H), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=COVER_QUALITY, method=6)
    return buf.getvalue()


def cmd_export(args: argparse.Namespace) -> None:
    api = Api(args.api)
    picks = json.loads(Path(args.picks).read_text())
    ids = {o["id"] for o in load_outfits()}
    unknown = sorted(set(picks) - ids)
    if unknown:
        sys.exit(f"picks name unknown outfits: {unknown}")
    COVERS.mkdir(parents=True, exist_ok=True)
    total = 0
    for oid, image_id in sorted(picks.items()):
        data = cover_bytes(api.raw(image_path(image_id, "file")))
        target = COVERS / f"{oid}.webp"
        if target.exists() and target.read_bytes() == data:
            continue
        target.write_bytes(data)
        total += len(data)
        print(f"{oid}: {len(data) // 1024} KB")
    missing = sorted(ids - set(picks))
    stale = sorted(p.stem for p in COVERS.glob("*.webp") if p.stem not in ids)
    print(f"wrote {total // 1024} KB; {len(missing)} outfit(s) still without a pick")
    if missing:
        print("  " + ", ".join(missing))
    if stale:
        print(f"covers for outfits no longer listed (delete them): {', '.join(stale)}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--api", default="http://127.0.0.1:8000", help="Moiré's address")
    p.add_argument("--work", default=str(REPO / ".cache" / "starter-covers"))
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check", help="validate the outfit file")

    q = sub.add_parser("queue", help="queue one batch of candidates per outfit")
    q.add_argument("--base", default="", help="quality tags put first in every prompt")
    q.add_argument("--negative", default="", help="negative prompt")
    q.add_argument("--generator", default="builtin")
    q.add_argument("--checkpoint")
    q.add_argument("--width", type=int)
    q.add_argument("--height", type=int)
    q.add_argument("--count", type=int, default=4, help="candidates per outfit")
    q.add_argument("--only", help="comma-separated outfit ids")
    q.add_argument("--redo", help="comma-separated outfit ids to queue again, new seed")
    q.add_argument(
        "--dry-run", action="store_true", help="print the batches, queue nothing"
    )

    sub.add_parser("status", help="how far the queued batches are")

    s = sub.add_parser("sheet", help="write the contact sheet to pick covers from")
    s.add_argument("--picks", help="earlier picks.json to start from")

    e = sub.add_parser("export", help="write the picked covers into the package data")
    e.add_argument("--picks", required=True)

    args = p.parse_args()
    {
        "check": cmd_check,
        "queue": cmd_queue,
        "status": cmd_status,
        "sheet": cmd_sheet,
        "export": cmd_export,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
