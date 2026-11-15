"""moire.main:app with a reduced lifespan: schema + sensitivity state only.
No AI worker, watchers, ComfyUI generation manager or update check.
Run: uvicorn web_app:app --lifespan on (PYTHONPATH=this dir)."""

from contextlib import asynccontextmanager
import anyio
import os
from pathlib import Path
from moire import web_ui

if os.environ.get("BENCH_WEB_DIR"):  # serve a scratch build instead of src/moire/web
    web_ui.mount_web_ui.__defaults__ = (Path(os.environ["BENCH_WEB_DIR"]),)
from moire import main
from moire.database.db import ensure_schema
from moire.services.tags import sensitivity as tag_sensitivity, sensitivity_filter


@asynccontextmanager
async def lifespan(app):
    await ensure_schema()
    await anyio.to_thread.run_sync(tag_sensitivity.load_overrides_sync)
    await anyio.to_thread.run_sync(sensitivity_filter.load_sync)
    yield


main.app.router.lifespan_context = lifespan
app = main.app
