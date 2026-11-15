"""Bench launcher (scan bench): a Moire backend on a bench DB copy.

usage: serve.py <db> <thumbs> <port> [--lifespan]

Same env as bench/api/serve.py (empty env file, no file log, no update
check), ports 8830-8839 only. Bench-only routes:
  POST /__bench/reproject?force=1   reproject_all(force) in a thread (no HTTP route forces)
  GET  /__bench/stats               tag_index invalidations / view builds, RSS, WAL size
Pass WATCH_ENABLED_DEFAULT=false in the env to add libraries unwatched.
The DB must have been through make_safe.py first when --lifespan is on.
"""

import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import benv  # noqa: E402

db, thumbs, port = (
    Path(sys.argv[1]).resolve(),
    Path(sys.argv[2]).resolve(),
    int(sys.argv[3]),
)
with_lifespan = "--lifespan" in sys.argv
assert 8830 <= port <= 8839, "scan bench ports 8830-8839 only"
benv.setup(db, thumbs)

import uvicorn  # noqa: E402

from moire.main import app  # noqa: E402
from moire.services.tags import index as tag_index  # noqa: E402
from moire.services.tags import sensitivity as tag_sensitivity  # noqa: E402
from moire.services.tags import sensitivity_filter  # noqa: E402

if not with_lifespan:
    tag_sensitivity.load_overrides_sync()
    sensitivity_filter.load_sync()

STATS = {"invalidate": 0, "invalidate_soft": 0, "builds": {}, "build_s": 0.0}
_oi, _ois, _oc = tag_index.invalidate, tag_index.invalidate_soft, tag_index.cached


def _inv():
    STATS["invalidate"] += 1
    _oi()


def _invs():
    STATS["invalidate_soft"] += 1
    _ois()


async def _cached(name, key, build, *args, **kw):
    async def counted():
        t0 = time.perf_counter()
        try:
            return await build()
        finally:
            STATS["builds"][name] = STATS["builds"].get(name, 0) + 1
            STATS["build_s"] += time.perf_counter() - t0

    return await _oc(name, key, counted, *args, **kw)


tag_index.invalidate, tag_index.invalidate_soft, tag_index.cached = _inv, _invs, _cached


@app.get("/__bench/stats")
async def _bench_stats():
    rss, hwm = benv.proc_mem()
    wal = Path(f"{db}-wal")
    return {
        **STATS,
        "rss_MB": rss,
        "hwm_MB": hwm,
        "cpu_s": benv.proc_cpu(),
        "wal_MB": round(wal.stat().st_size / 1e6, 2) if wal.exists() else 0,
        "threads": threading.active_count(),
    }


@app.post("/__bench/reproject")
async def _bench_reproject(force: int = 0):
    from moire.services.metadata import reproject

    def run():
        t0 = time.perf_counter()
        n = reproject.reproject_all(force=bool(force))
        STATS["last_reproject"] = {"n": n, "s": round(time.perf_counter() - t0, 2)}

    threading.Thread(target=run, name="bench-reproject", daemon=True).start()
    return {"started": True}


for _ in range(2):
    app.router.routes.insert(0, app.router.routes.pop())

uvicorn.run(
    app,
    host="127.0.0.1",
    port=port,
    lifespan="on" if with_lifespan else "off",
    log_level="warning",
    access_log=False,
)
