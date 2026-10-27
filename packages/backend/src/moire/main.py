from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .api import activity, libraries, images, tags, ai, rules, generate, onboarding
from .core.config import API_PREFIX
from .core.logging_setup import setup_logging
from .core.middleware import GZipExceptMedia, RescanRateLimit, SlowRequestLog
from .services import startup
from .web_ui import mount_web_ui
from . import __version__


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    await startup.start()
    yield
    await startup.stop()


# pyproject.toml is the one version (scripts/version.mjs keeps the rest in step).
app = FastAPI(title="Moiré API", version=__version__, lifespan=lifespan)

app.add_middleware(GZipExceptMedia)

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
    expose_headers=["X-Next-Cursor"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static thumbnails mount removed; thumbnails served via API from the FS (THUMB_ROOT)

# Outermost (added last): the slow-request log times everything inside it,
# the rate limiter's 429s included.
app.add_middleware(RescanRateLimit)
app.add_middleware(SlowRequestLog)


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
api.include_router(generate.router, prefix="/generate", tags=["generate"])
api.include_router(activity.router, prefix="/activity", tags=["activity"])
api.include_router(onboarding.router, prefix="/onboarding", tags=["onboarding"])
app.include_router(api)
# Last, so its catch-all route never shadows an API route.
mount_web_ui(app)
