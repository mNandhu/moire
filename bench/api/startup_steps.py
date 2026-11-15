"""Time each startup.start() DB step directly on a DB copy.

usage: startup_steps.py <dataset_dir>
Runs: ensure_schema, load_overrides_sync, sensitivity_filter.load_sync,
migrations.run_pending, nesting.adopt_nested_copies, sync_levels. (The AI
worker, watchers, generation manager and update check are not started.)
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benv  # noqa: E402

BENCH = benv.BENCH
ds = Path(sys.argv[1]).resolve()
assert "bench/api" in str(ds)
benv.setup(ds / "moire.db", ds / "thumbs")
t_imp = time.perf_counter()
import moire.main  # noqa: E402,F401  (import cost of the app)
from moire.database.db import ensure_schema  # noqa: E402
from moire.services.library import nesting  # noqa: E402
from moire.services.tags import migrations, sensitivity, sensitivity_filter  # noqa: E402

print(f"import moire.main: {(time.perf_counter() - t_imp) * 1000:.0f} ms")


def step(name, fn):
    t0 = time.perf_counter()
    r = fn()
    print(f"{name:28s} {(time.perf_counter() - t0) * 1000:8.0f} ms")
    return r


async def main():
    t0 = time.perf_counter()
    await ensure_schema()
    print(f"{'ensure_schema':28s} {(time.perf_counter() - t0) * 1000:8.0f} ms")
    step("load_overrides_sync", sensitivity.load_overrides_sync)
    step("sensitivity_filter.load_sync", sensitivity_filter.load_sync)
    step("migrations.run_pending", migrations.run_pending)
    step("nesting.adopt_nested_copies", nesting.adopt_nested_copies)
    step("sensitivity.sync_levels", sensitivity.sync_levels)


asyncio.run(main())
