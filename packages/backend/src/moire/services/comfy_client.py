"""Thin async client for one ComfyUI server: REST via httpx, events via its
websocket. No Moiré state here; :mod:`services.generation_jobs` owns that.

The optional headers (auth for a proxied ComfyUI) are sent on every request
and on the websocket handshake. They stay server-side: the browser never talks
to ComfyUI.
"""

from __future__ import annotations

import json
import logging
import ssl
import uuid
from typing import Any, AsyncIterator, Callable

import httpx

log = logging.getLogger(__name__)
# The websocket client logs every reconnect attempt at INFO; a ComfyUI that is
# off would fill the log. Moiré reports the connection state itself.
logging.getLogger("websockets.client").setLevel(logging.WARNING)

# One id for this Moiré process: ComfyUI routes per-prompt websocket events to
# the client_id the prompt was queued with.
CLIENT_ID = uuid.uuid4().hex

# Generous: a tunnelled or proxied ComfyUI can take several seconds just for
# the TLS handshake. Connections are pooled, so later calls are fast.
_TIMEOUT = httpx.Timeout(60.0, connect=15.0)


class ComfyUnreachable(Exception):
    """Connection refused, DNS failure, timeout: ComfyUI is down."""


class ComfyError(Exception):
    """ComfyUI answered with an error other than a rejected prompt."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class ComfyRejected(Exception):
    """``POST /prompt`` failed validation. ``node_errors`` is flattened to
    ``[{node, class_type, type, message, input}]``."""

    def __init__(self, message: str, node_errors: list[dict[str, Any]]):
        super().__init__(message)
        self.message = message
        self.node_errors = node_errors


def flatten_node_errors(body: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node_id, entry in (body.get("node_errors") or {}).items():
        for err in entry.get("errors") or []:
            extra = err.get("extra_info") or {}
            out.append(
                {
                    "node": str(node_id),
                    "class_type": entry.get("class_type"),
                    "type": err.get("type"),
                    "message": err.get("message") or "",
                    "details": err.get("details") or "",
                    "input": extra.get("input_name"),
                }
            )
    return out


def ws_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://") :]
    return f"{base}/ws?clientId={CLIENT_ID}"


def normalize_address(address: str) -> str:
    a = (address or "").strip().rstrip("/")
    if a and "://" not in a:
        a = "http://" + a
    return a


class ComfyClient:
    def __init__(
        self,
        address: str,
        headers: dict[str, str] | None = None,
        *,
        ca_cert: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = normalize_address(address)
        self.headers = dict(headers or {})
        # A self-signed ComfyUI (HTTPS behind a tunnel) is verified against its
        # own certificate rather than not verified at all.
        self._ssl = ssl.create_default_context(cafile=ca_cert) if ca_cert else None
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers=self.headers,
            timeout=_TIMEOUT,
            transport=transport,
            verify=self._ssl if self._ssl is not None else True,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        try:
            return await self._http.request(method, path, **kw)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as e:
            raise ComfyUnreachable(str(e) or type(e).__name__) from e
        except httpx.HTTPError as e:
            raise ComfyUnreachable(str(e) or type(e).__name__) from e

    async def _json(self, method: str, path: str, **kw: Any) -> Any:
        r = await self._request(method, path, **kw)
        if r.status_code in (401, 403):
            raise ComfyError(
                f"ComfyUI refused the request headers (HTTP {r.status_code})",
                r.status_code,
            )
        if r.status_code >= 400:
            raise ComfyError(f"{method} {path}: HTTP {r.status_code}", r.status_code)
        if not r.content:
            return None
        return r.json()

    async def view(self, subfolder: str, filename: str) -> bytes:
        """An output image's original bytes (``GET /view``), for a ComfyUI
        whose output folder this machine can't see."""
        r = await self._request(
            "GET",
            "/view",
            params={"filename": filename, "subfolder": subfolder, "type": "output"},
            timeout=httpx.Timeout(120.0, connect=5.0),
        )
        if r.status_code >= 400:
            raise ComfyError(f"GET /view: HTTP {r.status_code}", r.status_code)
        return r.content

    async def system_stats(self) -> dict[str, Any]:
        return await self._json("GET", "/system_stats")

    async def object_info(self, class_type: str) -> dict[str, Any]:
        return (await self._json("GET", f"/object_info/{class_type}")) or {}

    async def node_info(self) -> dict[str, Any]:
        """Every node class ComfyUI has with its inputs (``GET /object_info``,
        all of it: the one-class route can't take a name with a slash)."""
        return (await self._json("GET", "/object_info")) or {}

    async def lora_metadata(self, name: str) -> dict[str, Any] | None:
        """A LoRA file's safetensors metadata (``GET /view_metadata/loras``);
        ``None`` when the file has none."""
        r = await self._request(
            "GET", "/view_metadata/loras", params={"filename": name}
        )
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise ComfyError(
                f"GET /view_metadata/loras: HTTP {r.status_code}", r.status_code
            )
        try:
            body = r.json()
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    async def embeddings(self) -> list[str]:
        return list((await self._json("GET", "/embeddings")) or [])

    async def queue_prompt(
        self, graph: dict[str, Any], pnginfo: dict[str, Any] | None = None
    ) -> str:
        """Queue a prompt; returns its prompt_id. ``pnginfo`` keys are saved
        into the images as text chunks (``extra_pnginfo``). Raises
        :class:`ComfyRejected` when ComfyUI's validation fails."""
        body: dict[str, Any] = {"prompt": graph, "client_id": CLIENT_ID}
        if pnginfo:
            body["extra_data"] = {"extra_pnginfo": pnginfo}
        r = await self._request("POST", "/prompt", json=body)
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400 or body.get("node_errors") or "error" in body:
            if r.status_code >= 500 and not body:
                raise ComfyError(f"POST /prompt: HTTP {r.status_code}", r.status_code)
            err = body.get("error")
            message = (
                err.get("message")
                if isinstance(err, dict)
                else (
                    err
                    or (
                        "ComfyUI refused the workflow"
                        if body.get("node_errors")
                        else f"HTTP {r.status_code}"
                    )
                )
            )
            raise ComfyRejected(str(message), flatten_node_errors(body))
        return str(body["prompt_id"])

    async def history(self, prompt_id: str) -> dict[str, Any] | None:
        body = (await self._json("GET", f"/history/{prompt_id}")) or {}
        return body.get(prompt_id)

    async def queue(self) -> tuple[list[str], list[str]]:
        """(running prompt_ids, pending prompt_ids)."""
        body = (await self._json("GET", "/queue")) or {}

        def ids(items: list[Any]) -> list[str]:
            return [str(it[1]) for it in items if isinstance(it, list) and len(it) > 1]

        return ids(body.get("queue_running") or []), ids(
            body.get("queue_pending") or []
        )

    async def interrupt(self, prompt_id: str | None = None) -> None:
        # Newer ComfyUI only interrupts the given prompt; older ignores the body
        # and interrupts whatever runs, so callers only send it for a running
        # prompt of ours.
        await self._json(
            "POST", "/interrupt", json={"prompt_id": prompt_id} if prompt_id else {}
        )

    async def delete_queued(self, prompt_ids: list[str]) -> None:
        await self._json("POST", "/queue", json={"delete": prompt_ids})

    async def events(
        self,
        *,
        connect: Callable[..., Any] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Websocket JSON events (``{"type", "data"}``) forever, reconnecting
        with backoff. Binary frames (previews) are skipped."""
        if connect is None:
            from websockets.asyncio.client import connect as ws_connect

            connect = ws_connect
        from websockets.exceptions import ConnectionClosed

        extra: dict[str, Any] = {"ssl": self._ssl} if self._ssl is not None else {}
        async for ws in connect(
            ws_url(self.base_url), additional_headers=self.headers or None, **extra
        ):
            try:
                async for raw in ws:
                    if isinstance(raw, (bytes, bytearray)):
                        continue
                    try:
                        msg = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(msg, dict) and "type" in msg:
                        yield msg
            except ConnectionClosed:
                pass
