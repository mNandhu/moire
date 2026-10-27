"""The app's own ASGI middleware. Pure ASGI, so media responses (thumbnails,
originals) stream through untouched instead of being wrapped per request."""

from __future__ import annotations

import logging
import time

from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import API_PREFIX, settings

logger = logging.getLogger("moire")


class GZipExceptMedia:
    """GZip for API responses; the media routes (an image's ``/thumb`` and
    ``/file``) pass through untouched. Images and video are already
    compressed: gzipping a thumbnail made it larger, an original saved ~2%
    for ~30 ms of CPU, and both lost Content-Length. Level 6 (zlib's
    default) costs less CPU than 9 for nearly the same size."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1000, compresslevel=6)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "") if scope["type"] == "http" else ""
        if path.startswith(f"{API_PREFIX}/images/") and path.endswith(
            ("/thumb", "/file")
        ):
            await self.app(scope, receive, send)
        else:
            await self.gzip(scope, receive, send)


class SlowRequestLog:
    """Logs a request that took ``log_slow_requests_ms`` or longer, timed
    until its response starts (or it raised): a big original streaming to a
    slow client isn't a slow handler."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()
        started: list[float] = []

        async def timed_send(message) -> None:
            if message["type"] == "http.response.start" and not started:
                started.append(time.perf_counter())
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        finally:
            end = started[0] if started else time.perf_counter()
            dur_ms = (end - start) * 1000.0
            if dur_ms >= settings.log_slow_requests_ms:
                # Keep logs lightweight; uvicorn already logs access lines.
                logger.warning(
                    "slow request method=%s path=%s duration_ms=%.1f",
                    scope["method"],
                    scope["path"],
                    dur_ms,
                )


class RescanRateLimit:
    """Optional per-process rate limit (``rate_limit_enabled``) on the one
    high-impact endpoint, POST /libraries/{id}/rescan: per client IP,
    ``rate_limit_rescan_per_minute`` in a fixed 60 s window, then 429."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.state: dict[tuple[str, str], tuple[float, int]] = {}

    def _limited(self, scope: Scope) -> bool:
        path = scope["path"]
        if not (
            scope["method"].upper() == "POST"
            and path.endswith("/rescan")
            and path.startswith(f"{API_PREFIX}/libraries/")
        ):
            return False
        client = scope.get("client")
        ip = client[0] if client else "unknown"
        key = (ip, "libraries:rescan")
        now = time.time()
        # Expired windows go, so one entry per IP doesn't pile up forever.
        for k in [k for k, (w, _) in self.state.items() if now - w >= 60]:
            del self.state[k]
        window_start, count = self.state.get(key, (now, 0))
        if now - window_start >= 60:
            window_start, count = now, 0
        count += 1
        self.state[key] = (window_start, count)
        return count > max(1, settings.rate_limit_rescan_per_minute)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or not settings.rate_limit_enabled
            or not self._limited(scope)
        ):
            await self.app(scope, receive, send)
            return
        response = JSONResponse(
            status_code=429,
            content={"detail": "Rate limit exceeded"},
            headers={"Retry-After": "60"},
        )
        await response(scope, receive, send)
