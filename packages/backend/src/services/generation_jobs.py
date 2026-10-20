"""Generation batches: turn a press of Queue into ComfyUI requests and track
them to the end.

ComfyUI's ``/queue`` and ``/history`` are the source of truth: a poll loop
(:meth:`GenerationManager.tick`, about once a second) moves each request from
queued to running to done / failed / cancelled / lost and records its outputs.
The websocket only adds live step progress and wakes the loop early, so a
missed event never loses state. One request per batch is in ComfyUI at a time;
the rest wait here as pending, which keeps cancel simple and lets other
batches interleave.

The first request of a batch is submitted inside :meth:`queue_batch`: if
ComfyUI rejects it, nothing is kept and the caller gets the node errors.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import os
from pathlib import Path, PurePath
from typing import Any

import httpx
import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import builtin_generator, comfy_models, comfy_settings, generation_estimate
from .comfy_client import ComfyClient, ComfyError, ComfyRejected, ComfyUnreachable
from .generation_compose import auto_name, compose, compose_parts, prompt_terms
from .generator_graph import (
    SAMPLING,
    GraphError,
    build_prompt,
    merge_loras,
    seeds_for,
    split_requests,
)

log = logging.getLogger("moire.generate")

UNFINISHED = ("pending", "queued", "running")
IN_COMFY = ("queued", "running")


class Unavailable(Exception):
    """ComfyUI isn't configured or reachable; nothing was queued."""


class Invalid(Exception):
    """The request can't be queued as asked (bad generator, no output folder)."""


class Rejected(Exception):
    """ComfyUI rejected the first request; nothing was kept."""

    def __init__(self, message: str, node_errors: list[dict[str, Any]]):
        super().__init__(message)
        self.message = message
        self.node_errors = node_errors


def _write_atomic(dest: Path, data: bytes) -> None:
    # Dot-prefixed staging name: the library watcher ignores it until the rename.
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.part")
    tmp.write_bytes(data)
    os.replace(tmp, dest)


def output_image_id(library_id: str, subfolder: str, filename: str) -> str:
    """The `_id` the scanner gives the file once it lands in the output
    library (`{library_id}:{relative path}`, platform separators)."""
    rel = PurePath(subfolder, filename) if subfolder else PurePath(filename)
    return f"{library_id}:{rel}"


def outputs_from_history(entry: dict[str, Any]) -> list[tuple[str, str]]:
    """(subfolder, filename) of every saved output image, in node order."""
    files: list[tuple[str, str]] = []
    for node_id in sorted(
        (entry.get("outputs") or {}).keys(), key=lambda k: (len(k), k)
    ):
        for img in entry["outputs"][node_id].get("images") or []:
            if img.get("type", "output") == "output" and img.get("filename"):
                files.append((img.get("subfolder") or "", img["filename"]))
    return files


def history_result(entry: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """Final state of a prompt from its history entry: done / failed /
    cancelled, plus the error doc for failed."""
    status = entry.get("status") or {}
    messages = status.get("messages") or []
    for item in messages:
        if (
            isinstance(item, list)
            and len(item) == 2
            and item[0] == "execution_interrupted"
        ):
            return "cancelled", None
    for item in messages:
        if isinstance(item, list) and len(item) == 2 and item[0] == "execution_error":
            d = item[1] or {}
            return "failed", {
                "node": str(d.get("node_id") or ""),
                "class_type": d.get("node_type"),
                "type": d.get("exception_type"),
                "message": d.get("exception_message") or "",
            }
    if status.get("status_str") == "error":
        return "failed", {
            "node": "",
            "class_type": None,
            "type": None,
            "message": "ComfyUI reported an error",
        }
    return "done", None


_ENDS = ("execution_success", "execution_error", "execution_interrupted")


def batch_shape(
    gen: dict[str, Any], body: dict[str, Any], settings: dict[str, Any]
) -> dict[str, Any]:
    """The parts of a batch's inputs that decide how much work it is, as
    queue_batch keeps them (the run-time estimate reads the same):

    - ``count``, clamped;
    - ``per_request``: images per request, the body's choice, else the
      setting (built-in) or the Generator's; ``None`` when the Generator has
      no batch size (count is then in requests);
    - ``per_request_asked``: what the body chose, apart from the setting;
    - ``checkpoint``, ``sampling`` (only slots the Generator has), ``width``,
      ``height``."""
    has_batch = bool(gen["slots"].get("batch_size"))
    builtin = gen["kind"] == "builtin"
    asked = (
        max(1, min(64, int(body["per_request"])))
        if has_batch and body.get("per_request")
        else None
    )
    if not has_batch:
        per_request = None
    elif asked:
        per_request = asked
    elif builtin:
        per_request = int(settings.get("builtin_per_request") or 1)
    else:
        per_request = gen["slots"].get("per_request")
    return {
        "count": max(1, min(500, int(body.get("count") or 1))),
        "per_request": per_request,
        "per_request_asked": asked,
        # Only where the graph lets Moiré set it (a custom one keeps its own).
        "checkpoint": (body.get("checkpoint") or None)
        if gen["slots"].get("checkpoint")
        else None,
        "sampling": _sampling_input(body.get("sampling"), gen["slots"]),
        "width": body.get("width"),
        "height": body.get("height"),
    }


def model_loaded(entry: dict[str, Any], node_id: str | None) -> bool | None:
    """Whether a prompt had to load its checkpoint: ComfyUI's history lists
    the nodes it reused from cache (``execution_cached``), so a checkpoint
    loader that isn't among them ran, and read the model from disk. ``None``
    when that can't be told (no checkpoint node, no such message)."""
    if not node_id:
        return None
    for item in (entry.get("status") or {}).get("messages") or []:
        if (
            isinstance(item, list)
            and len(item) == 2
            and item[0] == "execution_cached"
            and isinstance(item[1], dict)
        ):
            nodes = item[1].get("nodes") or []
            return str(node_id) not in {str(n) for n in nodes}
    return None


def run_seconds(entry: dict[str, Any]) -> float | None:
    """How long ComfyUI ran a prompt: its history's ``execution_start`` to
    the message that ended it (timestamps in ms). None when either is missing."""
    start = end = None
    for item in (entry.get("status") or {}).get("messages") or []:
        if not (
            isinstance(item, list) and len(item) == 2 and isinstance(item[1], dict)
        ):
            continue
        ts = item[1].get("timestamp")
        if not isinstance(ts, (int, float)):
            continue
        if item[0] == "execution_start":
            start = ts
        elif item[0] in _ENDS:
            end = ts
    if start is None or end is None or end < start:
        return None
    return round((end - start) / 1000, 2)


_PART_KINDS = ("text", "character", "embedding")


def _parts(raw: Any) -> list[dict[str, Any]] | None:
    """The composer's ordered prompt parts: text (``role`` says which layer:
    prefix, prompt, text, preset), the character's tags, an embedding.
    ``None`` when the body has none (an old-style batch)."""
    if not isinstance(raw, list):
        return None
    out = []
    for p in raw[:64]:
        if not isinstance(p, dict) or p.get("kind") not in _PART_KINDS:
            continue
        out.append(
            {
                "kind": p["kind"],
                "role": str(p.get("role") or "")[:20],
                "label": str(p.get("label") or "")[:120],
                "text": str(p.get("text") or "")[:8000],
                "name": str(p.get("name") or "")[:400],
            }
        )
    return out


def _resolve(
    parts: list[dict[str, Any]], characters: list[dict[str, Any]]
) -> list[str | list[str]]:
    """Parts as :func:`compose_parts` items: text raw, each character's tags
    as its own chip block, in order (nothing when none is picked), embeddings
    as words."""
    items: list[str | list[str]] = []
    for p in parts:
        if p["kind"] == "text":
            items.append(p["text"])
        elif p["kind"] == "character":
            items.extend(c["tags"] for c in characters)
        elif p["name"]:
            items.append(f"embedding:{p['name']}")
    return items


MAX_CHARACTERS = 8


def characters_of(holder: dict[str, Any]) -> list[dict[str, Any]]:
    """The characters of a queue body or a batch's inputs: ``characters``, or
    the single ``character`` older batches have. Pure."""
    many = holder.get("characters")
    if isinstance(many, list):
        return [c for c in many if isinstance(c, dict)]
    one = holder.get("character")
    return [one] if isinstance(one, dict) else []


def _characters_input(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The body's characters as the batch keeps them, each tag once."""
    out: list[dict[str, Any]] = []
    for raw in characters_of(body)[:MAX_CHARACTERS]:
        c = _character_input(raw)
        if c and all(x["tag"] != c["tag"] for x in out):
            out.append(c)
    return out


def _sampling_input(raw: Any, slots: dict[str, Any]) -> dict[str, Any]:
    """The sampler settings asked for, for the slots this Generator has."""
    if not isinstance(raw, dict):
        return {}
    return {k: raw[k] for k in SAMPLING if raw.get(k) is not None and slots.get(k)}


def _character_input(c: dict[str, Any] | None) -> dict[str, Any] | None:
    """The Character block as the batch keeps it: tag, display label, the tags
    sent, and its LoRA (an installed file name) if any."""
    if not c or not c.get("tag"):
        return None
    lora = c.get("lora")
    return {
        "tag": c["tag"],
        "label": (c.get("label") or "").strip(),
        "tags": [w for w in (c.get("tags") or []) if isinstance(w, str) and w.strip()],
        "lora": {"name": lora["name"], "strength": float(lora.get("strength", 1.0))}
        if lora and lora.get("name")
        else None,
    }


def annotate_node_errors(
    errors: list[dict[str, Any]], gen: dict[str, Any], graph: dict[str, Any]
) -> list[dict[str, Any]]:
    """Add ``field`` (checkpoint / lora / positive / negative) to each node
    error, so the composer can flag the control it came from. A LoRA loader
    the Generator's own graph doesn't have was added by Moiré (``added``)."""
    slots = gen.get("slots") or {}

    def slot_node(key: str) -> str | None:
        path = slots.get(key)
        return str(path[0]) if path else None

    def at_slot(key: str, node: str, err: dict[str, Any]) -> bool:
        # The sampler node has other inputs (seed, model, latent): match the input too.
        path = slots.get(key)
        return bool(path) and node == str(path[0]) and err.get("input") == path[1]

    out = []
    for err in errors:
        node = str(err.get("node") or "")
        extra: dict[str, Any] = {"field": None}
        cls = (graph.get(node) or {}).get("class_type")
        if node and node == slot_node("checkpoint"):
            extra["field"] = "checkpoint"
        elif node and any(at_slot(k, node, err) for k in SAMPLING):
            extra["field"] = "sampling"
        elif cls in ("LoraLoader", "LoraLoaderModelOnly"):
            extra = {
                "field": "lora",
                "lora_name": graph[node]["inputs"].get("lora_name"),
                "added": node not in (gen.get("graph") or {}),
            }
        elif node and node == slot_node("positive"):
            extra["field"] = "positive"
        elif node and node == slot_node("negative"):
            extra["field"] = "negative"
        out.append({**err, **extra})
    return out


async def load_generator(generator_id: str) -> dict[str, Any] | None:
    """A Generator row; the built-in is created on first read."""
    async with async_conn() as conn:
        row = (
            await conn.execute(
                sa.select(t.generators).where(t.generators.c._id == generator_id)
            )
        ).first()
    if row is not None:
        gen = dict(row._mapping)
        if gen["kind"] == "builtin" and (
            gen["graph"] != builtin_generator.graph()
            or gen["slots"] != builtin_generator.slots()
        ):
            # Moiré's own graph: a stored copy from before a new slot is updated.
            gen["graph"] = builtin_generator.graph()
            gen["slots"] = builtin_generator.slots()
            async with async_tx() as conn:
                await conn.execute(
                    sa.update(t.generators)
                    .where(t.generators.c._id == generator_id)
                    .values(graph=gen["graph"], slots=gen["slots"])
                )
        return gen
    if generator_id != builtin_generator.BUILTIN_ID:
        return None
    now = time.time()
    doc = {
        "_id": builtin_generator.BUILTIN_ID,
        "name": builtin_generator.BUILTIN_NAME,
        "kind": "builtin",
        "source": None,
        "graph": builtin_generator.graph(),
        "slots": builtin_generator.slots(),
        "ready": False,
        "test": None,
        "created_at": now,
        "updated_at": now,
    }
    async with async_tx() as conn:
        await conn.execute(
            sa.insert(t.generators).prefix_with("OR IGNORE").values(**doc)
        )
    return doc


class GenerationManager:
    def __init__(self) -> None:
        self.client: ComfyClient | None = None
        # Tests swap in an httpx.MockTransport / fake websocket connect.
        self.transport: httpx.AsyncBaseTransport | None = None
        self.ws_connect: Any = None
        self.connected = False
        self.error: str | None = None
        self.queue_remaining = 0
        self.progress: dict[str, dict[str, Any]] = {}
        # When ComfyUI started running each prompt (our clock): the run-time
        # estimate counts down from it.
        self.started: dict[str, float] = {}
        self._loop_task: asyncio.Task | None = None
        self._ws_task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._tick_lock = asyncio.Lock()
        self._models_loaded = False
        # Poll cadence (s) with requests in flight / idle; tests shorten it.
        self.interval = 1.0
        self.idle_interval = 5.0

    # -- lifecycle -------------------------------------------------------------

    def start(self) -> None:
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        for task in (self._loop_task, self._ws_task):
            if task:
                task.cancel()
        if self.client:
            await self.client.aclose()

    async def configure(self) -> None:
        """(Re)build the client from settings; restart the websocket."""
        s = await comfy_settings.get_settings()
        if self._ws_task:
            self._ws_task.cancel()
            self._ws_task = None
        if self.client:
            await self.client.aclose()
        self.client = None
        self.connected = False
        self._models_loaded = False
        self.error = None
        if not s.get("address"):
            return
        self.client = ComfyClient(
            s["address"],
            s.get("headers") or {},
            ca_cert=s.get("ca_cert") or None,
            transport=self.transport,
        )
        if self._loop_task is not None:
            self._ws_task = asyncio.create_task(self._ws_loop(self.client))
        self._wake.set()

    async def check(self, *, refresh_models: bool = False) -> bool:
        """Ping ComfyUI; on (re)connect, refresh the model index."""
        if self.client is None:
            self.connected = False
            return False
        try:
            await self.client.system_stats()
        except (ComfyUnreachable, ComfyError) as e:
            self._down(str(e))
            return False
        self._up()
        if refresh_models or not self._models_loaded:
            try:
                await comfy_models.refresh(self.client)
                self._models_loaded = True
            except (ComfyUnreachable, ComfyError) as e:
                log.warning("ComfyUI model refresh failed: %s", e)
        return True

    def _up(self) -> None:
        self.connected = True
        self.error = None

    def _down(self, error: str) -> None:
        if self.connected:
            log.info("ComfyUI unreachable: %s", error)
        self.connected = False
        self.error = error
        self._models_loaded = False

    async def _run(self) -> None:
        try:
            await self.configure()
        except Exception:
            log.exception("ComfyUI configure failed")
        while True:
            try:
                active = await self.tick()
            except Exception:
                log.exception("generation tick failed")
                active = False
            self._wake.clear()
            try:
                await asyncio.wait_for(
                    self._wake.wait(),
                    timeout=self.interval if active else self.idle_interval,
                )
            except asyncio.TimeoutError:
                pass

    async def _ws_loop(self, client: ComfyClient) -> None:
        while True:
            try:
                async for msg in client.events(connect=self.ws_connect):
                    self._on_event(msg)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.debug("ComfyUI websocket: %s", e)
            await asyncio.sleep(5)

    def _on_event(self, msg: dict[str, Any]) -> None:
        kind, data = msg.get("type"), msg.get("data") or {}
        if kind == "status":
            info = (data.get("status") or {}).get("exec_info") or {}
            self.queue_remaining = int(info.get("queue_remaining") or 0)
        elif kind == "progress" and data.get("prompt_id"):
            self.progress[data["prompt_id"]] = {
                "value": data.get("value"),
                "max": data.get("max"),
                "node": data.get("node"),
            }
        if kind == "execution_start" and data.get("prompt_id"):
            self.started.setdefault(data["prompt_id"], time.time())
        if kind in (
            "execution_success",
            "execution_error",
            "execution_interrupted",
            "execution_start",
        ):
            self._wake.set()

    # -- status ----------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "configured": self.client is not None,
            "connected": self.connected,
            "error": self.error,
            "busy": self.queue_remaining > 0,
            "queue_remaining": self.queue_remaining,
        }

    # -- the poll loop ---------------------------------------------------------

    async def tick(self) -> bool:
        """One pass: sync request states with ComfyUI, submit the next
        request of idle batches. Returns whether anything is in flight."""
        async with self._tick_lock:
            if self.client is None:
                return False
            if not self.connected or not self._models_loaded:
                if not await self.check():
                    return await self._has_unfinished()
            try:
                running, pending = await self.client.queue()
            except (ComfyUnreachable, ComfyError) as e:
                self._down(str(e))
                return await self._has_unfinished()
            self._up()
            self.queue_remaining = len(running) + len(pending)
            await self._sync(set(running), set(pending))
            await self._submit_next()
            return await self._has_unfinished()

    async def _has_unfinished(self) -> bool:
        async with async_conn() as conn:
            n = (
                await conn.execute(
                    sa.select(sa.func.count())
                    .select_from(t.generation_requests)
                    .where(t.generation_requests.c.state.in_(UNFINISHED))
                )
            ).scalar()
        return bool(n)

    async def _sync(self, running: set[str], pending: set[str]) -> None:
        assert self.client is not None
        r = t.generation_requests
        async with async_conn() as conn:
            rows = (
                await conn.execute(
                    sa.select(r.c._id, r.c.batch_id, r.c.prompt_id, r.c.state).where(
                        r.c.state.in_(IN_COMFY)
                    )
                )
            ).fetchall()
        for row in rows:
            pid = row.prompt_id
            if pid in running:
                if row.state != "running":
                    await self._set_state(row._id, "running")
                continue
            if pid in pending:
                continue
            entry = await self.client.history(pid)
            if entry is None:
                await self._set_state(row._id, "lost", finished=True)
                self.progress.pop(pid, None)
                self.started.pop(pid, None)
                continue
            await self._finalize(row._id, pid, entry)
        # Start times of prompts that are neither ours nor still in ComfyUI
        # (another client's, or one that ended without us finalizing it).
        keep = running | pending | {row.prompt_id for row in rows}
        for pid in [p for p in self.started if p not in keep]:
            del self.started[pid]
        await self._close_finished_batches()

    async def _set_state(
        self, request_id: int, state: str, *, finished: bool = False, **extra: Any
    ) -> None:
        values: dict[str, Any] = {"state": state, **extra}
        if finished:
            values["finished_at"] = time.time()
        async with async_tx() as conn:
            await conn.execute(
                sa.update(t.generation_requests)
                .where(t.generation_requests.c._id == request_id)
                .values(**values)
            )

    async def _finalize(
        self, request_id: int, prompt_id: str, entry: dict[str, Any]
    ) -> None:
        state, error = history_result(entry)
        files = outputs_from_history(entry)
        s = await comfy_settings.get_settings()
        lib = s.get("output_library_id") or ""
        node = await self._checkpoint_node(request_id)
        async with async_tx() as conn:
            await conn.execute(
                sa.delete(t.generation_outputs).where(
                    t.generation_outputs.c.request_id == request_id
                )
            )
            if files:
                await conn.execute(
                    sa.insert(t.generation_outputs),
                    [
                        {
                            "request_id": request_id,
                            "idx": i,
                            "subfolder": sub,
                            "filename": name,
                            "image_id": output_image_id(lib, sub, name),
                        }
                        for i, (sub, name) in enumerate(files)
                    ],
                )
            await conn.execute(
                sa.update(t.generation_requests)
                .where(t.generation_requests.c._id == request_id)
                .values(
                    state=state, error=error, finished_at=time.time(), progress=None
                )
            )
            await conn.execute(
                sa.delete(t.generation_run_times).where(
                    t.generation_run_times.c.request_id == request_id
                )
            )
            seconds = run_seconds(entry)
            if seconds is not None:
                await conn.execute(
                    sa.insert(t.generation_run_times).values(
                        request_id=request_id, seconds=seconds
                    )
                )
            await conn.execute(
                sa.delete(t.generation_run_loads).where(
                    t.generation_run_loads.c.request_id == request_id
                )
            )
            cold = model_loaded(entry, node)
            if cold is not None:
                await conn.execute(
                    sa.insert(t.generation_run_loads).values(
                        request_id=request_id, cold=cold
                    )
                )
        generation_estimate.forget()
        self.progress.pop(prompt_id, None)
        self.started.pop(prompt_id, None)
        if files and lib and s.get("download_outputs", True):
            await self._fetch_missing(lib, files)

    def running_for(self, prompt_id: str | None) -> float | None:
        """Seconds since ComfyUI started ``prompt_id``; None until it has."""
        at = self.started.get(prompt_id) if prompt_id else None
        return max(0.0, time.time() - at) if at is not None else None

    async def _checkpoint_node(self, request_id: int) -> str | None:
        """The node id of the checkpoint loader in the request's Generator."""
        async with async_conn() as conn:
            gen_id = (
                await conn.execute(
                    sa.select(t.generation_batches.c.generator_id)
                    .select_from(
                        t.generation_requests.join(
                            t.generation_batches,
                            t.generation_batches.c._id
                            == t.generation_requests.c.batch_id,
                        )
                    )
                    .where(t.generation_requests.c._id == request_id)
                )
            ).scalar()
        gen = await load_generator(gen_id) if gen_id else None
        slot = (gen or {}).get("slots", {}).get("checkpoint")
        return str(slot[0]) if slot else None

    async def _fetch_missing(
        self, library_id: str, files: list[tuple[str, str]]
    ) -> None:
        """Download outputs this machine can't see (ComfyUI on another host)
        into the output library, where the watcher picks them up. A local
        ComfyUI already wrote them there, so nothing is fetched."""
        assert self.client is not None
        async with async_conn() as conn:
            root = (
                await conn.execute(
                    sa.select(t.libraries.c.path).where(t.libraries.c._id == library_id)
                )
            ).scalar()
        if not root:
            return
        base = Path(root).resolve()
        for sub, name in files:
            dest = (base / sub / name).resolve()
            if not dest.is_relative_to(base) or dest.exists():
                continue
            try:
                data = await self.client.view(sub, name)
            except (ComfyUnreachable, ComfyError) as e:
                log.warning("Could not fetch %s/%s from ComfyUI: %s", sub, name, e)
                continue
            await asyncio.to_thread(_write_atomic, dest, data)

    async def _close_finished_batches(self) -> None:
        b, r = t.generation_batches, t.generation_requests
        open_ = (
            sa.select(r.c._id)
            .where(r.c.batch_id == b.c._id, r.c.state.in_(UNFINISHED))
            .exists()
        )
        async with async_tx() as conn:
            await conn.execute(
                sa.update(b)
                .where(b.c.state == "active", ~open_)
                .values(state="finished")
            )

    async def _submit_next(self) -> None:
        """Submit the lowest pending request of every active batch that has
        nothing in ComfyUI."""
        r = t.generation_requests
        busy = sa.select(r.c.batch_id).where(r.c.state.in_(IN_COMFY))
        async with async_conn() as conn:
            rows = (
                await conn.execute(
                    sa.select(r.c.batch_id, sa.func.min(r.c.idx).label("idx"))
                    .where(r.c.state == "pending", r.c.batch_id.not_in(busy))
                    .group_by(r.c.batch_id)
                    .order_by(r.c.batch_id)
                )
            ).fetchall()
        for row in rows:
            try:
                await self._submit(row.batch_id, row.idx)
            except ComfyRejected as e:
                await self._fail_request(row.batch_id, row.idx, e)
            except (ComfyUnreachable, ComfyError) as e:
                self._down(str(e))
                return

    async def _fail_request(self, batch_id: int, idx: int, e: ComfyRejected) -> None:
        first = e.node_errors[0] if e.node_errors else {}
        error = {
            "node": first.get("node", ""),
            "class_type": first.get("class_type"),
            "type": "rejected",
            "message": "; ".join(
                f"{n['message']}: {n['details']}".strip(": ") for n in e.node_errors
            )
            or e.message,
        }
        r = t.generation_requests
        async with async_tx() as conn:
            await conn.execute(
                sa.update(r)
                .where(r.c.batch_id == batch_id, r.c.idx == idx)
                .values(state="failed", error=error, finished_at=time.time())
            )

    async def _submit(self, batch_id: int, idx: int) -> str:
        """Build and send one request. Raises ComfyRejected / ComfyUnreachable."""
        assert self.client is not None
        b, r = t.generation_batches, t.generation_requests
        async with async_conn() as conn:
            batch = (await conn.execute(sa.select(b).where(b.c._id == batch_id))).one()
            req = (
                await conn.execute(
                    sa.select(r).where(r.c.batch_id == batch_id, r.c.idx == idx)
                )
            ).one()
        gen = await load_generator(batch.generator_id)
        if gen is None:
            raise ComfyRejected("Its workflow was deleted", [])
        inputs = batch.inputs
        values = {
            "positive": inputs["positive_text"],
            "negative": inputs["negative_text"],
            "seed": req.seed,
            "width": inputs.get("width"),
            "height": inputs.get("height"),
            "batch_size": req.images,
            "checkpoint": inputs.get("checkpoint"),
            **(inputs.get("sampling") or {}),
            "loras": merge_loras(
                [c.get("lora") for c in characters_of(inputs)], inputs.get("loras")
            ),
        }
        try:
            graph = build_prompt(gen["graph"], gen["slots"], values)
        except GraphError as e:
            raise ComfyRejected(str(e), []) from e
        try:
            pid = await self.client.queue_prompt(graph)
        except ComfyRejected as e:
            e.node_errors = annotate_node_errors(e.node_errors, gen, graph)
            raise
        async with async_tx() as conn:
            await conn.execute(
                sa.update(r)
                .where(r.c._id == req._id)
                .values(state="queued", prompt_id=pid, queued_at=time.time())
            )
        return pid

    # -- actions ---------------------------------------------------------------

    async def _require_connection(self) -> dict[str, Any]:
        s = await comfy_settings.get_settings()
        if self.client is None:
            raise Unavailable("ComfyUI isn't set up")
        if not await self.check():
            raise Unavailable("Can't reach ComfyUI")
        if not s.get("output_library_id"):
            raise Invalid("Set ComfyUI's output folder first")
        return s

    async def queue_batch(self, body: dict[str, Any], *, test: bool = False) -> int:
        """Create a batch and submit its first request. Raises Unavailable,
        Invalid or Rejected (then nothing is kept)."""
        s = await self._require_connection()
        gen = await load_generator(
            body.get("generator_id") or builtin_generator.BUILTIN_ID
        )
        if gen is None:
            raise Invalid("Unknown workflow")
        if not gen["ready"] and not test:
            raise Invalid("Run the workflow's test first")

        shape = batch_shape(gen, body, s)
        count = shape["count"]
        sizes = split_requests(count, shape["per_request"])
        seed = body.get("seed") or {}
        fixed = (
            int(seed["value"])
            if seed.get("mode") == "fixed" and seed.get("value") is not None
            else None
        )
        seeds = seeds_for(len(sizes), fixed=fixed)

        extra = list(body.get("extra") or [])
        characters = _characters_input(body)
        inputs = {
            "base": body.get("base") or "",
            "extra": extra,
            "negative_base": body.get("negative_base") or "",
            "negative_extra": list(body.get("negative_extra") or []),
            "checkpoint": shape["checkpoint"],
            "sampling": shape["sampling"],
            "loras": [
                {"name": lo["name"], "strength": float(lo.get("strength", 1.0))}
                for lo in body.get("loras") or []
            ],
            "characters": characters,
            # The first, for readers of batches from before several.
            "character": characters[0] if characters else None,
            "width": shape["width"],
            "height": shape["height"],
            "seed": {
                "mode": "fixed" if fixed is not None else "random",
                "value": fixed,
            },
            "count": count,
            "per_request": shape["per_request"],
            # What the user set, apart from the setting it resolved to.
            "per_request_asked": shape["per_request_asked"],
            "test": test,
        }
        positive = _parts(body.get("positive"))
        if positive is not None:
            # The layered composer: ordered parts, and its own state for
            # "Edit and queue" (opaque here).
            negative = _parts(body.get("negative")) or []
            inputs["positive"] = positive
            inputs["negative"] = negative
            composer = body.get("composer")
            inputs["composer"] = (
                composer
                if isinstance(composer, dict) and len(json.dumps(composer)) < 50_000
                else None
            )
            inputs["positive_text"] = compose_parts(_resolve(positive, characters))
            inputs["negative_text"] = compose_parts(_resolve(negative, []))
            extra = prompt_terms(
                " , ".join(p["text"] for p in positive if p.get("role") == "prompt")
            )
        else:
            inputs["positive_text"] = compose(
                inputs["base"], [w for c in characters for w in c["tags"]], extra
            )
            inputs["negative_text"] = compose(
                inputs["negative_base"], inputs["negative_extra"]
            )

        async with self._tick_lock:
            batch_id = await self._insert_and_submit(
                gen, inputs, sizes, seeds, body, extra
            )
        self._wake.set()
        return batch_id

    async def _insert_and_submit(
        self,
        gen: dict[str, Any],
        inputs: dict[str, Any],
        sizes: list[int | None],
        seeds: list[int],
        body: dict[str, Any],
        name_words: list[str],
    ) -> int:
        """Caller holds ``_tick_lock``, so the loop can't see the new pending
        rows (and submit them too) or a stale queue snapshot (and call the new
        prompt lost)."""
        b, r = t.generation_batches, t.generation_requests
        now = time.time()
        async with async_tx() as conn:
            res = await conn.execute(
                sa.insert(b).values(
                    name="",
                    auto_name=True,
                    generator_id=gen["_id"],
                    inputs=inputs,
                    state="active",
                    created_at=now,
                )
            )
            batch_id = int(res.inserted_primary_key[0])  # type: ignore[index]
            given = (body.get("name") or "").strip()
            who = [c["label"] or c["tag"] for c in characters_of(inputs)]
            name = given or auto_name(
                number=batch_id,
                generator=gen["name"],
                extra=name_words,
                character=" & ".join(who) if who else None,
            )
            await conn.execute(
                sa.update(b)
                .where(b.c._id == batch_id)
                .values(name=name, auto_name=not given)
            )
            await conn.execute(
                sa.insert(r),
                [
                    {
                        "batch_id": batch_id,
                        "idx": i,
                        "seed": sd,
                        "images": n,
                        "state": "pending",
                    }
                    for i, (n, sd) in enumerate(zip(sizes, seeds))
                ],
            )
        try:
            await self._submit(batch_id, 0)
        except ComfyRejected as e:
            await self._delete_batch(batch_id)
            raise Rejected(e.message, e.node_errors) from e
        except (ComfyUnreachable, ComfyError) as e:
            await self._delete_batch(batch_id)
            self._down(str(e))
            raise Unavailable(str(e)) from e
        return batch_id

    async def _delete_batch(self, batch_id: int) -> None:
        async with async_tx() as conn:
            await conn.execute(
                sa.delete(t.generation_batches).where(
                    t.generation_batches.c._id == batch_id
                )
            )

    async def requeue(self, batch_id: int) -> int:
        async with async_conn() as conn:
            row = (
                await conn.execute(
                    sa.select(t.generation_batches).where(
                        t.generation_batches.c._id == batch_id
                    )
                )
            ).first()
        if row is None:
            raise Invalid("Unknown batch")
        inputs = row.inputs
        body = {
            **{
                k: inputs.get(k)
                for k in (
                    "base",
                    "extra",
                    "negative_base",
                    "negative_extra",
                    "checkpoint",
                    "sampling",
                    "loras",
                    "character",
                    "characters",
                    "positive",
                    "negative",
                    "composer",
                    "width",
                    "height",
                    "count",
                    "seed",
                )
            },
            # Only a size the user chose is replayed; else today's setting.
            "per_request": inputs.get("per_request_asked"),
            "generator_id": row.generator_id,
            "name": None if row.auto_name else row.name,
        }
        return await self.queue_batch(body)

    async def retry(
        self, batch_id: int, request_id: int, *, single: bool = False
    ) -> None:
        async with self._tick_lock:
            await self._retry(batch_id, request_id, single=single)
        self._wake.set()

    async def _retry(self, batch_id: int, request_id: int, *, single: bool) -> None:
        r = t.generation_requests
        async with async_conn() as conn:
            req = (
                await conn.execute(
                    sa.select(r).where(r.c._id == request_id, r.c.batch_id == batch_id)
                )
            ).first()
            outputs = (
                await conn.execute(
                    sa.select(sa.func.count())
                    .select_from(t.generation_outputs)
                    .where(t.generation_outputs.c.request_id == request_id)
                )
            ).scalar()
            top = (
                await conn.execute(
                    sa.select(sa.func.max(r.c.idx)).where(r.c.batch_id == batch_id)
                )
            ).scalar()
        if req is None or req.state not in ("failed", "lost", "cancelled", "done"):
            raise Invalid("Only a finished request can be retried")
        if req.state == "done" and outputs:
            # Its images are in the library; retrying would drop them from the batch.
            raise Invalid("This request returned images")
        async with async_tx() as conn:
            if single and (req.images or 0) > 1:
                await conn.execute(
                    sa.update(r).where(r.c._id == request_id).values(state="replaced")
                )
                await conn.execute(
                    sa.insert(r),
                    [
                        {
                            "batch_id": batch_id,
                            "idx": (top or 0) + 1 + i,
                            "seed": req.seed,
                            "images": 1,
                            "state": "pending",
                        }
                        for i in range(req.images)
                    ],
                )
            else:
                for table in (
                    t.generation_outputs,
                    t.generation_run_times,
                    t.generation_run_loads,
                ):
                    await conn.execute(
                        sa.delete(table).where(table.c.request_id == request_id)
                    )
                await conn.execute(
                    sa.update(r)
                    .where(r.c._id == request_id)
                    .values(
                        state="pending",
                        prompt_id=None,
                        error=None,
                        progress=None,
                        queued_at=None,
                        finished_at=None,
                    )
                )
            await conn.execute(
                sa.update(t.generation_batches)
                .where(t.generation_batches.c._id == batch_id)
                .values(state="active")
            )
        generation_estimate.forget()

    async def cancel(self, batch_id: int, request_id: int | None = None) -> None:
        """Cancel a batch's unfinished requests, or just one of them."""
        async with self._tick_lock:
            await self._cancel(batch_id, request_id)
        self._wake.set()

    async def _cancel(self, batch_id: int, request_id: int | None) -> None:
        r = t.generation_requests
        scope = [r.c.batch_id == batch_id]
        if request_id is not None:
            scope.append(r.c._id == request_id)
        async with async_conn() as conn:
            rows = (
                await conn.execute(
                    sa.select(r.c._id, r.c.state, r.c.prompt_id).where(
                        *scope, r.c.state.in_(UNFINISHED)
                    )
                )
            ).fetchall()
        queued = [x.prompt_id for x in rows if x.state == "queued" and x.prompt_id]
        running = [x.prompt_id for x in rows if x.state == "running" and x.prompt_id]
        async with async_tx() as conn:
            await conn.execute(
                sa.update(r)
                .where(*scope, r.c.state.in_(("pending", "queued")))
                .values(state="cancelled", finished_at=time.time())
            )
        if self.client is not None:
            try:
                if queued:
                    await self.client.delete_queued(queued)
                if running:
                    # Older ComfyUI ignores the prompt_id and interrupts whatever
                    # runs, so only interrupt when ours is running right now.
                    # Its final state (cancelled) then comes from /history.
                    now_running, _ = await self.client.queue()
                    for pid in running:
                        if pid in now_running:
                            await self.client.interrupt(pid)
            except (ComfyUnreachable, ComfyError) as e:
                self._down(str(e))
        await self._close_finished_batches()


_manager: GenerationManager | None = None


def get_generation_manager() -> GenerationManager:
    global _manager
    if _manager is None:
        _manager = GenerationManager()
    return _manager


def reset_for_tests() -> None:
    global _manager
    _manager = None
    generation_estimate.forget()
