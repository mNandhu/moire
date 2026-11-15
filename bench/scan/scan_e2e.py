"""End-to-end library scan, in-process (no HTTP), through the real
scanner.scan_library_async + its post-scan reprojection thread.

usage: scan_e2e.py <run_name> --db DB --thumbs DIR --lib FOLDER [--lib FOLDER ...]
                   [--fresh] [--cold] [--workers N] [--instrument]

--fresh   delete DB + thumbs first (new empty DB via ensure_schema_sync)
--cold    posix_fadvise(DONTNEED) every image under the libraries first
--workers sets SCANNER_MAX_WORKERS (0 = default min(16, cpu_count))
--instrument  wall + thread-CPU timers around each stage (adds a little overhead)

Writes results/<run_name>.json and prints a summary.
"""

import argparse
import json
import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("name")
ap.add_argument("--db", required=True)
ap.add_argument("--thumbs", required=True)
ap.add_argument("--lib", action="append", required=True)
ap.add_argument("--fresh", action="store_true")
ap.add_argument("--cold", action="store_true")
ap.add_argument("--workers", type=int, default=0)
ap.add_argument("--instrument", action="store_true")
a = ap.parse_args()

db = Path(a.db).resolve()
thumbs = Path(a.thumbs).resolve()
if a.fresh:
    for f in (db, Path(f"{db}-wal"), Path(f"{db}-shm")):
        f.unlink(missing_ok=True)
    shutil.rmtree(thumbs, ignore_errors=True)
db.parent.mkdir(parents=True, exist_ok=True)
benv.setup(db, thumbs, SCANNER_MAX_WORKERS=str(a.workers))

import sqlalchemy as sa  # noqa: E402

from moire.database import schema as t  # noqa: E402
from moire.database.db import ensure_schema_sync, sync_conn, sync_tx  # noqa: E402
from moire.services.library import scanner, thumbnailer  # noqa: E402
from moire.services.library.ops import library_id_for  # noqa: E402
from moire.services.metadata import reproject  # noqa: E402
from moire.services.tags import index as tag_index  # noqa: E402

ensure_schema_sync()
with sync_tx() as conn:
    # make_safe equivalents for a fresh DB: no face detection / auto-tag.
    conn.execute(
        sa.text("insert or ignore into app_settings(_id, doc) values ('ai', json(:d))"),
        {"d": json.dumps({"face_detect": False, "auto_tag": False})},
    )

libs = []
for f in a.lib:
    path = str(Path(f).resolve())
    lid = library_id_for(path)
    libs.append((lid, path))
    with sync_tx() as conn:
        conn.execute(
            sa.text(
                "insert or ignore into libraries(_id, path, name, indexed_count, watch_enabled)"
                " values (:i, :p, :n, 0, 0)"
            ),
            {"i": lid, "p": path, "n": Path(path).name},
        )

files = [
    p for _, path in libs for p in Path(path).rglob("*") if thumbnailer.is_image(p)
]
nbytes = sum(p.stat().st_size for p in files)
if a.cold:
    benv.evict(files)

# ---- instrumentation -------------------------------------------------------
stages: dict[str, list[float]] = {}  # name -> [calls, wall, cpu]
_slock = threading.Lock()


def wrap(owner, attr, name):
    orig = getattr(owner, attr)

    def w(*args, **kw):
        w0, c0 = time.perf_counter(), time.thread_time()
        try:
            return orig(*args, **kw)
        finally:
            dw, dc = time.perf_counter() - w0, time.thread_time() - c0
            with _slock:
                s = stages.setdefault(name, [0, 0.0, 0.0])
                s[0] += 1
                s[1] += dw
                s[2] += dc

    setattr(owner, attr, w)


inv_count = [0]
_orig_inv = tag_index.invalidate


def _count_inv():
    inv_count[0] += 1
    _orig_inv()


tag_index.invalidate = _count_inv
reproject.tag_index.invalidate = _count_inv

if a.instrument:
    from PIL import Image as PILImage

    from moire.services.library import scan_reconcile
    from moire.services.metadata import gen_metadata, workflow_identity

    wrap(scanner, "process_image", "process_image (total, per worker)")
    wrap(thumbnailer.PILImage, "open", "PIL open+header")
    wrap(gen_metadata, "read_gen_raw", "read_gen_raw (= PNG decode)")
    wrap(PILImage.Image, "thumbnail", "thumbnail (resize; decode for non-PNG)")
    wrap(PILImage.Image, "save", "webp encode")
    wrap(thumbnailer, "blurhash_for_image", "blurhash")
    wrap(workflow_identity, "workflow_sig", "workflow_sig")
    wrap(scanner, "put_thumb", "put_thumb (FS write)")
    wrap(scanner, "_commit_batch", "DB upsert batch (coordinator)")
    wrap(scanner, "_lib_set", "library progress write")
    wrap(scanner, "_walk", "walk")
    wrap(scanner, "_load_known", "load known rows")
    wrap(scan_reconcile, "reconcile", "reconcile stale")
    wrap(reproject, "_flush_batch", "reproject flush batch")
    wrap(gen_metadata, "derive", "reproject derive")

# ---- sampler ---------------------------------------------------------------
samples = []
stop = threading.Event()


def sampler():
    wal = Path(f"{db}-wal")
    while not stop.is_set():
        rss, hwm = benv.proc_mem()
        samples.append(
            (
                time.perf_counter(),
                benv.proc_cpu(),
                rss,
                hwm,
                wal.stat().st_size if wal.exists() else 0,
                threading.active_count(),
            )
        )
        stop.wait(0.2)


load_before = benv.load_avg()
sth = threading.Thread(target=sampler, daemon=True)
sth.start()
cpu0 = benv.proc_cpu()
t0 = time.perf_counter()
for lid, path in libs:
    scanner.scan_library_async(lid, path)
time.sleep(0.05)
while scanner.any_scanning():
    time.sleep(0.02)
t_scan = time.perf_counter() - t0
cpu_scan = benv.proc_cpu() - cpu0
# post-scan reprojection runs in its own thread(s)
time.sleep(0.05)
while reproject.busy() or any(
    th.name.startswith("reproject") for th in threading.enumerate()
):
    time.sleep(0.02)
t_all = time.perf_counter() - t0
cpu_all = benv.proc_cpu() - cpu0
stop.set()
sth.join()

with sync_conn() as conn:
    rows = conn.execute(
        sa.select(
            t.libraries.c.name,
            t.libraries.c.indexed_count,
            t.libraries.c.scan_failed_count,
            t.libraries.c.scan_error,
        )
    ).fetchall()
    n_img = conn.execute(sa.select(sa.func.count()).select_from(t.images)).scalar()
    n_gen = conn.execute(
        sa.text("select count(*) from images where json_type(gen)='object'")
    ).scalar()

peak_rss = max(s[2] for s in samples)
peak_wal = max(s[4] for s in samples)
res = {
    "name": a.name,
    "libs": [p for _, p in libs],
    "files": len(files),
    "MB": round(nbytes / 1e6, 1),
    "cold": a.cold,
    "workers_setting": a.workers,
    "scan_s": round(t_scan, 3),
    "scan_plus_reproject_s": round(t_all, 3),
    "img_per_s_scan": round(len(files) / t_scan, 1),
    "MB_per_s_scan": round(nbytes / 1e6 / t_scan, 1),
    "cpu_s_scan": round(cpu_scan, 2),
    "cores_used_scan": round(cpu_scan / t_scan, 2),
    "cpu_s_all": round(cpu_all, 2),
    "peak_rss_MB": peak_rss,
    "peak_wal_MB": round(peak_wal / 1e6, 1),
    "final_wal_MB": round(
        (Path(f"{db}-wal").stat().st_size if Path(f"{db}-wal").exists() else 0) / 1e6,
        1,
    ),
    "tag_index_invalidations": inv_count[0],
    "images_in_db": n_img,
    "images_with_gen": n_gen,
    "libraries": [dict(r._mapping) for r in rows],
    "load_before": load_before,
    "load_after": benv.load_avg(),
    "stages": {
        k: {
            "calls": v[0],
            "wall_s": round(v[1], 3),
            "cpu_s": round(v[2], 3),
            "wall_ms_per_call": round(v[1] * 1000 / max(1, v[0]), 2),
            "cpu_ms_per_call": round(v[2] * 1000 / max(1, v[0]), 2),
        }
        for k, v in stages.items()
    },
}
out = benv.BENCH / "results" / f"{a.name}.json"
out.write_text(json.dumps(res, indent=1, default=str))
print(
    f"{a.name}: files={len(files)} {res['MB']}MB cold={a.cold} workers={a.workers or 'default'}"
    f"  scan {t_scan:.2f}s ({res['img_per_s_scan']} img/s, {res['MB_per_s_scan']} MB/s)"
    f"  +reproject {t_all:.2f}s  cores {res['cores_used_scan']}/12"
    f"  rss {peak_rss}MB wal {res['peak_wal_MB']}MB inval {inv_count[0]}  load {load_before}"
)
for k, v in res["stages"].items():
    print(
        f"   {k:42s} n={v['calls']:5d} wall {v['wall_s']:8.2f}s cpu {v['cpu_s']:8.2f}s"
        f"  {v['wall_ms_per_call']:7.2f}/{v['cpu_ms_per_call']:7.2f} ms/call"
    )
for r in res["libraries"]:
    print("  ", r)
