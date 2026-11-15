"""Bench launcher: a Moiré backend on a bench DB copy, lifespan OFF.

usage: serve.py <dataset_dir> <port> [--lifespan]

Sets SQLITE_PATH/THUMB_ROOT/MODEL_CACHE_DIR to the bench copies, an empty env
file, no file log, no update check. Loads the same read-only state startup
loads (tag level overrides, sensitivity filter maximum) so the filter works
without the lifespan, and adds one bench-only route:
  POST /__bench/invalidate  -> tag_index.invalidate()   (app-cache cold)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

BENCH = benv.BENCH
ds = Path(sys.argv[1]).resolve()
port = int(sys.argv[2])
with_lifespan = "--lifespan" in sys.argv
assert 8810 <= port <= 8819, "bench ports 8810-8819 only"

benv.setup(ds / "moire.db", ds / "thumbs")

import uvicorn  # noqa: E402

from moire.main import app  # noqa: E402
from moire.services.tags import index as tag_index  # noqa: E402
from moire.services.tags import sensitivity as tag_sensitivity  # noqa: E402
from moire.services.tags import sensitivity_filter  # noqa: E402

if not with_lifespan:
    tag_sensitivity.load_overrides_sync()
    sensitivity_filter.load_sync()


@app.post("/__bench/invalidate")
async def _bench_invalidate():
    tag_index.invalidate()
    return {"ok": True}


# The catch-all web UI route was mounted before ours; move ours to the front.
app.router.routes.insert(0, app.router.routes.pop())

uvicorn.run(
    app,
    host="127.0.0.1",
    port=port,
    lifespan="on" if with_lifespan else "off",
    log_level="warning",
    access_log=False,
)
