"""Serve the built frontend (``pnpm build`` writes it to ``src/web``) from the
API process, so a packaged Moiré is one process on one port.

In dev the folder is usually absent and Vite serves the UI on :5173 instead;
then nothing is mounted.
"""

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

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
    "health",
    "docs",
    "redoc",
    "openapi.json",
)


def mount_web_ui(app: FastAPI, web_dir: Path = WEB_DIR) -> bool:
    """Register the UI routes last, after every API router. Returns whether a
    built UI was found."""
    index = web_dir / "index.html"
    if not index.is_file():
        logger.info("No built UI at %s; serve it with `pnpm dev`", web_dir)
        return False
    root = web_dir.resolve()

    async def ui(path: str = ""):
        if path.startswith(_NOT_UI):
            raise HTTPException(status_code=404)
        if path:
            target = (root / path).resolve()
            if target.is_relative_to(root) and target.is_file():
                headers = _IMMUTABLE if path.startswith("assets/") else None
                return FileResponse(target, headers=headers)
            if path.startswith("assets/"):
                raise HTTPException(status_code=404)
        # Any other path is a client-side route (React Router).
        return FileResponse(index, headers=_NO_CACHE)

    app.add_api_route("/", ui, methods=["GET", "HEAD"], include_in_schema=False)
    app.add_api_route(
        "/{path:path}", ui, methods=["GET", "HEAD"], include_in_schema=False
    )
    logger.info("Serving the UI from %s", web_dir)
    return True
