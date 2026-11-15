"""Per-stage cost of scanning one file, single thread (mirrors S-section stages.py).

Replays thumbnailer.make_thumb_bytes step by step, with img.load() split out so
decode and resize are timed apart, then the rest of process_image (workflow_sig,
put_thumb) and the reprojection's derive() for the same raw.

usage: stages.py <folder> [N] [--cold] [--cprofile out.prof]
"""

import argparse
import json
import statistics
import sys
import time
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

W = benv.BENCH / "work" / "stages"
W.mkdir(parents=True, exist_ok=True)
benv.setup(W / "stages.db", W / "thumbs")

from PIL import Image as PILImage  # noqa: E402

from moire.core.config import settings  # noqa: E402
from moire.services.library import scanner, thumbnailer  # noqa: E402
from moire.services.library.blurhash import blurhash_for_image  # noqa: E402
from moire.services.library.storage_fs import put_thumb  # noqa: E402
from moire.services.metadata import extraction_settings, gen_metadata, workflow_identity  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("folder")
ap.add_argument("n", type=int, nargs="?", default=100)
ap.add_argument("--cold", action="store_true")
ap.add_argument("--cprofile")
a = ap.parse_args()

files = sorted(p for p in Path(a.folder).rglob("*") if thumbnailer.is_image(p))[: a.n]
if a.cold:
    benv.evict(files)

st: dict[str, list[float]] = {}


def rec(k, t0):
    st.setdefault(k, []).append((time.perf_counter() - t0) * 1000)
    return time.perf_counter()


config = extraction_settings._config(None, None, {})  # default keywords, no rules

size = max(16, settings.thumb_max_size)
nbytes = 0
for p in files:
    t = time.perf_counter()
    stt = p.stat()
    nbytes += stt.st_size
    t = rec("stat", t)
    img = PILImage.open(p)
    w, h = img.size
    t = rec("open+header", t)
    raw = gen_metadata.read_gen_raw(img)
    t = rec("read_gen_raw (getexif -> full PNG decode)", t)
    img.draft("RGB", (size, size))
    img.load()
    t = rec("decode (load)", t)
    img.thumbnail((size, size))
    t = rec("resize", t)
    buf = BytesIO()
    img.save(buf, format="WEBP", quality=85)
    t = rec("webp encode", t)
    bh = blurhash_for_image(img)
    t = rec("blurhash", t)
    sig = (
        workflow_identity.workflow_sig(raw.get("prompt"))
        if raw and raw.get("source") == "comfyui"
        else None
    )
    t = rec("workflow_sig", t)
    iid = f"stagelib:{p.name}"
    put_thumb("stagelib", iid, buf.getvalue())
    t = rec("put_thumb", t)
    if raw is not None and config is not None:
        doc = {
            "_id": iid,
            "library_id": "stagelib",
            "workflow_sig": sig,
            **json.loads(json.dumps(raw)),
        }
        t = time.perf_counter()
        gen_metadata.derive(doc, None, config)
        rec("derive (reproject, not in scan)", t)
    img.close()

print(
    f"files={len(files)} MB={nbytes / 1e6:.0f} cold={a.cold} thumb={size} load={benv.load_avg()}"
)
tot = 0.0
for k, v in st.items():
    m = statistics.mean(v)
    if not k.startswith("derive"):
        tot += m
    print(
        f"  {k:34s} mean {m:7.2f}  p50 {statistics.median(v):7.2f}  max {max(v):7.2f} ms"
    )
print(
    f"  {'TOTAL scan per file':34s} mean {tot:7.2f} ms  -> {1000 / tot:.1f} img/s single thread"
)

if a.cprofile:
    import cProfile

    if a.cold:
        benv.evict(files)
    pr = cProfile.Profile()
    pr.enable()
    for p in files:
        scanner.process_image("stagelib", Path(a.folder), p, None)
    pr.disable()
    pr.dump_stats(a.cprofile)
    import pstats

    pstats.Stats(pr).sort_stats("tottime").print_stats(15)
