"""A fake ComfyUI for tests: REST via ``httpx.MockTransport``, events via a
scripted websocket the test pushes into.

``FakeComfy.run(prompt_id)`` plays a prompt through to success: it emits the
websocket events and records the history entry with ``images`` outputs, the
way ComfyUI does once a SaveImage node finishes.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx


class FakeComfy:
    def __init__(self) -> None:
        self.up = True
        self.checkpoints = ["illustriousXL_v01.safetensors", "sdxl/pony_v6.safetensors"]
        self.loras = ["styles/flat_color_xl.safetensors", "chars/hu_tao_v2.safetensors"]
        self.embedding_names = ["easynegative", "pos/aesthetic"]
        self.prompts: dict[str, dict[str, Any]] = {}  # prompt_id -> graph
        self.order: list[str] = []
        self.history: dict[str, dict[str, Any]] = {}
        self.pending: list[str] = []
        self.running: list[str] = []
        self.reject_next: dict[str, Any] | None = None
        self.interrupted: list[Any] = []
        self.deleted: list[str] = []
        self.headers_seen: list[dict[str, str]] = []
        self._n = 0
        self.ws_queue: asyncio.Queue[str | None] = asyncio.Queue()

    # -- REST ----------------------------------------------------------------

    def transport(self, latency: float = 0.0) -> httpx.MockTransport:
        """``latency`` makes every call yield to the event loop, so a running
        poll loop and API calls interleave the way they do for real."""
        if not latency:
            return httpx.MockTransport(self._handle)

        async def slow(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(latency)
            return self._handle(request)

        return httpx.MockTransport(slow)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.headers_seen.append(dict(request.headers))
        if not self.up:
            raise httpx.ConnectError("connection refused", request=request)
        path = request.url.path
        if path == "/system_stats":
            return httpx.Response(
                200, json={"system": {"comfyui_version": "0.3.0"}, "devices": []}
            )
        if path == "/object_info/CheckpointLoaderSimple":
            return httpx.Response(
                200,
                json={
                    "CheckpointLoaderSimple": {
                        "input": {"required": {"ckpt_name": [self.checkpoints]}}
                    }
                },
            )
        if path == "/object_info/LoraLoader":
            return httpx.Response(
                200,
                json={
                    "LoraLoader": {"input": {"required": {"lora_name": [self.loras]}}}
                },
            )
        if path == "/embeddings":
            return httpx.Response(200, json=self.embedding_names)
        if path == "/prompt" and request.method == "POST":
            if self.reject_next is not None:
                body, self.reject_next = self.reject_next, None
                return httpx.Response(400, json=body)
            graph = json.loads(request.content)["prompt"]
            self._n += 1
            pid = f"p{self._n}"
            self.prompts[pid] = graph
            self.order.append(pid)
            self.pending.append(pid)
            return httpx.Response(
                200, json={"prompt_id": pid, "number": self._n, "node_errors": {}}
            )
        if path.startswith("/history/"):
            pid = path.rsplit("/", 1)[-1]
            return httpx.Response(
                200, json={pid: self.history[pid]} if pid in self.history else {}
            )
        if path == "/queue" and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "queue_running": [[0, p, {}, {}, []] for p in self.running],
                    "queue_pending": [[0, p, {}, {}, []] for p in self.pending],
                },
            )
        if path == "/queue" and request.method == "POST":
            ids = json.loads(request.content).get("delete") or []
            self.deleted.extend(ids)
            self.pending = [p for p in self.pending if p not in ids]
            return httpx.Response(200)
        if path == "/view":
            name = request.url.params.get("filename", "")
            return httpx.Response(200, content=b"PNG:" + name.encode())
        if path == "/interrupt":
            self.interrupted.append(
                json.loads(request.content or b"{}").get("prompt_id")
            )
            return httpx.Response(200)
        return httpx.Response(404)

    # -- scripted prompt lifecycle --------------------------------------------

    def push(self, type_: str, data: dict[str, Any]) -> None:
        self.ws_queue.put_nowait(json.dumps({"type": type_, "data": data}))

    def start(self, pid: str) -> None:
        if pid in self.pending:
            self.pending.remove(pid)
        self.running.append(pid)
        self.push("execution_start", {"prompt_id": pid})
        self.push("progress", {"prompt_id": pid, "node": "3", "value": 1, "max": 4})

    def finish(
        self, pid: str, *, images: int | None = None, prefix: str = "moire/gen"
    ) -> list[str]:
        """Complete ``pid`` with ``images`` outputs (default: the graph's
        batch_size). Returns the output paths relative to the output folder."""
        if pid in self.pending:
            self.start(pid)
        if pid in self.running:
            self.running.remove(pid)
        graph = self.prompts[pid]
        if images is None:
            latent = next(
                (n for n in graph.values() if n["class_type"] == "EmptyLatentImage"),
                None,
            )
            images = int(latent["inputs"]["batch_size"]) if latent else 1
        sub, _, stem = prefix.rpartition("/")
        files = [
            {
                "filename": f"{stem}_{pid}_{i:05}_.png",
                "subfolder": sub,
                "type": "output",
            }
            for i in range(images)
        ]
        self.history[pid] = {
            "outputs": {"9": {"images": files}} if files else {},
            "status": {"status_str": "success", "completed": True, "messages": []},
        }
        self.push(
            "executed", {"prompt_id": pid, "node": "9", "output": {"images": files}}
        )
        self.push("execution_success", {"prompt_id": pid})
        self.push(
            "status",
            {
                "status": {
                    "exec_info": {
                        "queue_remaining": len(self.pending) + len(self.running)
                    }
                }
            },
        )
        return [
            f"{f['subfolder']}/{f['filename']}" if f["subfolder"] else f["filename"]
            for f in files
        ]

    def fail(self, pid: str, message: str = "CUDA out of memory") -> None:
        if pid in self.pending:
            self.start(pid)
        if pid in self.running:
            self.running.remove(pid)
        data = {
            "prompt_id": pid,
            "node_id": "3",
            "node_type": "KSampler",
            "exception_type": "torch.OutOfMemoryError",
            "exception_message": message,
            "traceback": [],
        }
        self.history[pid] = {
            "outputs": {},
            "status": {
                "status_str": "error",
                "completed": False,
                "messages": [["execution_error", data]],
            },
        }
        self.push("execution_error", data)

    # -- websocket -------------------------------------------------------------

    def connect(self, url: str, additional_headers: Any = None):
        fake = self

        class _WS:
            def __aiter__(self):
                return self

            async def __anext__(self):
                msg = await fake.ws_queue.get()
                if msg is None:
                    raise StopAsyncIteration
                return msg

        class _Connect:
            def __aiter__(self):
                self._done = False
                return self

            async def __anext__(self):
                while not fake.up:
                    await asyncio.sleep(0.01)
                if self._done:
                    # A closed fake socket stays closed until the test reopens it.
                    await asyncio.sleep(3600)
                self._done = True
                return _WS()

        return _Connect()
