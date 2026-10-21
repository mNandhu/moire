"""Serve the built frontend (``pnpm build`` writes it to ``src/moire/web``) from the
API process, so a packaged Moiré is one process on one port.

In dev the folder is usually absent and Vite serves the UI on :5173 instead;
then nothing is mounted.
"""

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .core.config import API_PREFIX

logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).parent / "web"

# Vite content-hashes everything under /assets, so it never goes stale.
_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
# index.html names the current hashed bundles; always revalidate it.
_NO_CACHE = {"Cache-Control": "no-cache"}

# Paths the SPA fallback must never answer with index.html.
_NOT_UI = (
    API_PREFIX.lstrip("/") + "/",
    "api/",
    "assets/",
    "health",
    "docs",
    "redoc",
    "openapi.json",
)


class _ImmutableAssets(StaticFiles):
    """Vite's hashed bundles: StaticFiles (ETag, Range, traversal guard) plus a
    forever cache header."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers.update(_IMMUTABLE)
        return response


def mount_web_ui(app: FastAPI, web_dir: Path = WEB_DIR) -> bool:
    """Serve the built UI. Returns whether one was found.

    Client routes are answered from the 404 handler, not a catch-all route, so
    the router behaves exactly as without a UI: API paths keep their 405s and
    trailing-slash redirects, and nothing under the API prefix ever gets HTML.
    """
    index = web_dir / "index.html"
    if not index.is_file():
        logger.info("No built UI at %s; serve it with `pnpm dev`", web_dir)
        return False
    root = web_dir.resolve()
    # Top-level files Vite copies from `public/` (favicon.svg, ...), by name.
    root_files = {p.name: p for p in root.iterdir() if p.is_file()}

    if (root / "assets").is_dir():
        app.mount("/assets", _ImmutableAssets(directory=root / "assets"), "assets")

    @app.exception_handler(StarletteHTTPException)
    async def _ui_fallback(request: Request, exc: StarletteHTTPException):
        path = request.url.path.lstrip("/")
        if (
            exc.status_code != 404
            or request.method not in ("GET", "HEAD")
            or path.startswith(_NOT_UI)
        ):
            return await http_exception_handler(request, exc)
        if path in root_files:
            return FileResponse(root_files[path])
        # Any other path is a client-side route (React Router).
        return FileResponse(index, headers=_NO_CACHE)

    logger.info("Serving the UI from %s", web_dir)
    return True
