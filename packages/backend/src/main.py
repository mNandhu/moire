from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from .api import libraries, images, tags, ai, rules
from .database.db import async_conn, ensure_schema
from .database import schema as t
from .core.config import API_PREFIX, settings
from .core.logging_setup import setup_logging
from .services.storage_fs import ensure_thumb_root
from .services.ai_jobs import get_ai_job_manager, get_ai_settings
from .services.ai_tagger import get_tagger_manager
from .services import library_watch

import logging
import time
import anyio  # type: ignore[import-not-found]
import sqlalchemy as sa

logger = logging.getLogger("moire")


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    # Startup: create the SQLite schema (tables + indexes) if absent. Declarative
    # DDL means no flag backfill is needed — columns carry their defaults.
    await ensure_schema()
    # Ensure the thumbnail root dir exists (run off the event loop)
    await anyio.to_thread.run_sync(ensure_thumb_root)  # type: ignore[attr-defined]

    # Start internal AI job worker
    jm = get_ai_job_manager()
    jm.start()
    try:
        s = await get_ai_settings()
        get_tagger_manager().set_idle_unload_s(int(s.get("idle_unload_s", 0) or 0))
    except Exception:
        # Best-effort; AI can still run with defaults, but log failures for operators.
        logger.exception("Failed to load AI settings during startup; continuing")

    # Start a filesystem watcher for every library that wants one. A library
    # added while the process is down only starts watching on the next boot.
    try:
        async with async_conn() as conn:
            rows = (
                await conn.execute(
                    sa.select(
                        t.libraries.c._id,
                        t.libraries.c.path,
                        t.libraries.c.watch_enabled,
                    )
                )
            ).fetchall()
        for r in rows:
            if r.watch_enabled:
                library_watch.start_watch(r._id, r.path)
    except Exception:
        logger.exception("Failed to start library watchers during startup")

    yield

    # Shutdown
    library_watch.stop_all()


app = FastAPI(title="Moiré API", version="0.1.0", lifespan=lifespan)

# GZip compression for JSON responses
app.add_middleware(GZipMiddleware, minimum_size=1000)

# CORS: allow frontend dev server and Docker frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://frontend",
        "http://frontend:80",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static thumbnails mount removed; thumbnails served via API from the FS (THUMB_ROOT)


_rl_state: dict[tuple[str, str], tuple[float, int]] = {}


@app.middleware("http")
async def _timing_and_rate_limit(request: Request, call_next):
    start = time.perf_counter()

    # Optional: per-process rate limiting for high-impact endpoints.
    if settings.rate_limit_enabled:
        path = request.url.path
        if (
            request.method.upper() == "POST"
            and path.endswith("/rescan")
            and path.startswith(f"{API_PREFIX}/libraries/")
        ):
            ip = request.client.host if request.client else "unknown"
            key = (ip, "libraries:rescan")
            now = time.time()
            window_start, count = _rl_state.get(key, (now, 0))
            if now - window_start >= 60:
                window_start, count = now, 0
            count += 1
            _rl_state[key] = (window_start, count)

            limit = max(1, settings.rate_limit_rescan_per_minute)
            if count > limit:
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Rate limit exceeded"},
                    headers={"Retry-After": "60"},
                )

    try:
        response = await call_next(request)
        return response
    finally:
        dur_ms = (time.perf_counter() - start) * 1000.0
        slow_ms = settings.log_slow_requests_ms
        if dur_ms >= slow_ms:
            # Keep logs lightweight; uvicorn already logs access lines.
            logger.warning(
                "slow request method=%s path=%s duration_ms=%.1f",
                request.method,
                request.url.path,
                dur_ms,
            )


@app.get("/health")
def health():
    return {"status": "ok"}


# Every API route lives under one versioned prefix, so a reverse proxy can route
# `/api/v1/*` straight through (no path rewriting) and split media from JSON
# (e.g. a dedicated `location ~ ^/api/v1/images/.+/file$` for Range/originals).
# `/health` stays at the root too, for container probes.
api = APIRouter(prefix=API_PREFIX)
api.add_api_route("/health", health, methods=["GET"], tags=["health"])
api.include_router(libraries.router, prefix="/libraries", tags=["libraries"])
api.include_router(images.router, prefix="/images", tags=["images"])
api.include_router(tags.router, prefix="/tags", tags=["tags"])
api.include_router(ai.router, prefix="/ai", tags=["ai"])
api.include_router(rules.router, prefix="/rules", tags=["rules"])
app.include_router(api)
