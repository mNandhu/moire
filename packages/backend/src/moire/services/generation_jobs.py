"""Generation batches: turn a press of Queue into ComfyUI requests and track
them to the end.

ComfyUI's ``/queue`` and ``/history`` are the source of truth: a poll loop
(:meth:`GenerationManager.tick`, about once a second) moves each request from
queued to running to done / failed / cancelled / lost and records its outputs.
The websocket only adds live step progress and wakes the loop early, so a
missed event never loses state. One request of ours is in ComfyUI at a time
and batches run one after another, oldest first (a test run goes ahead of
them); the rest wait here as pending, which keeps cancel simple.

The first request of a batch is submitted inside :meth:`queue_batch`: if
ComfyUI rejects it, nothing is kept and the caller gets the node errors.

The manager holds the connection and the poll state machine; the work it
hands off lives beside it: what a batch keeps (:mod:`generation_inputs`),
reading ComfyUI's history (:mod:`comfy_history`), where outputs land
(:mod:`generation_outputs`), Generator rows (:mod:`generators_store`) and
the state names (:mod:`generation_states`).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx
import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import (
    builtin_generator,
    comfy_models,
    comfy_settings,
    gen_metadata,
    generation_estimate,
)
from .comfy_client import ComfyClient, ComfyError, ComfyRejected, ComfyUnreachable
from .comfy_history import (
    history_result,
    model_loaded,
    outputs_from_history,
    run_seconds,
)
from .generation_compose import batch_name
from .generation_errors import (
    GraphInvalid,
    Invalid,
    Rejected,
    Unavailable,
    annotate_node_errors,
)
from .generation_inputs import (
    BatchPlan,
    build_batch_inputs,
    characters_of,
    replay_body,
)
from .generation_outputs import fetch_missing, place_outputs
from .generation_states import IN_COMFY, REPLACED, RETRYABLE, UNFINISHED
from .generators_store import load_generator
from .generator_graph import (
    GraphError,
    build_prompt,
    clear_display_text,
    drop_missing,
    family_pnginfo,
    fill_defaults,
    merge_loras,
)

log = logging.getLogger("moire.generate")

# Seconds between attempts to set up a connection that failed to (a missing
# certificate file, say): often enough to recover soon, not a log line a tick.
SETUP_RETRY = 60.0

# Order key: a batch that is a workflow's test run before the others.
TEST_FIRST = sa.desc(
    sa.func.coalesce(sa.func.json_extract(t.generation_batches.c.inputs, "$.test"), 0)
)


class GenerationManager:
    def __init__(self) -> None:
        self.client: ComfyClient | None = None
        # Tests swap in an httpx.MockTransport / fake websocket connect.
        self.transport: httpx.AsyncBaseTransport | None = None
        self.ws_connect: Any = None
        self._classes: dict[str, Any] | None = None
        self._setup_failed = False
        self._setup_retry_at = 0.0
        self.connected = False
        self.error: str | None = None
        self.queue_remaining = 0
        self.progress: dict[str, dict[str, Any]] = {}
        # When ComfyUI started running each prompt (our clock): the run-time
        # estimate counts down from it.
        self.started: dict[str, float] = {}
        # The batch being made: it goes on before older ones (a retry) and
        # newer ones. Set only when this picks a batch (not a test run, not
        # one that slipped in while parking); after a restart, oldest first.
        self.current: int | None = None
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
        self._classes = None
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

    async def _set_up(self) -> None:
        """configure(), kept from failing the loop: a failure (the certificate
        file's drive not mounted yet at boot, say) is shown in the status and
        retried on the next idle tick instead of leaving Moiré disconnected
        until someone presses Test."""
        try:
            await self.configure()
            self._setup_failed = False
        except Exception as e:
            # The whole traceback once; a retry that fails again is one line.
            if self._setup_failed:
                log.warning("ComfyUI configure failed again: %s", e)
            else:
                log.exception("ComfyUI configure failed")
            self._setup_failed = True
            self._setup_retry_at = time.monotonic() + SETUP_RETRY
            self.error = f"Couldn't set up the connection: {e}"

    async def _run(self) -> None:
        await self._set_up()
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
            if (
                self.client is None
                and self._setup_failed
                and time.monotonic() >= self._setup_retry_at
            ):
                await self._set_up()
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

    async def _has_unfinished(self, besides: int | None = None) -> bool:
        """Some request is still to finish (in a batch other than `besides`)."""
        r = t.generation_requests
        where = [r.c.state.in_(UNFINISHED)]
        if besides is not None:
            where.append(r.c.batch_id != besides)
        async with async_conn() as conn:
            row = (
                await conn.execute(sa.select(r.c._id).where(*where).limit(1))
            ).first()
        return row is not None

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
                # The websocket's execution_start sets the start time; a
                # missed event (reconnect, restart) would leave the request
                # with no elapsed time, so the poll sets it too.
                self.started.setdefault(pid, time.time())
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
        ids, fetch = await place_outputs(self.client, files, s)
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
                            "image_id": ids[i],
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
        if fetch and lib and s.get("download_outputs", True):
            await fetch_missing(self.client, lib, fetch)

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
        """With nothing of ours in ComfyUI, submit the lowest pending request
        of the first batch in line: test runs first, then the batch being
        made (so a retry on an old batch waits for it), then the oldest. A
        batch is done before the next starts."""
        r, b = t.generation_requests, t.generation_batches
        async with async_conn() as conn:
            busy = (
                await conn.execute(
                    sa.select(r.c._id).where(r.c.state.in_(IN_COMFY)).limit(1)
                )
            ).first()
            if busy:
                return
            row = (
                await conn.execute(
                    sa.select(
                        r.c.batch_id,
                        sa.func.min(r.c.idx).label("idx"),
                        sa.func.json_extract(b.c.inputs, "$.test").label("test"),
                    )
                    .select_from(r.join(b, b.c._id == r.c.batch_id))
                    .where(r.c.state == "pending")
                    .group_by(r.c.batch_id)
                    .order_by(
                        TEST_FIRST, r.c.batch_id != (self.current or -1), r.c.batch_id
                    )
                    .limit(1)
                )
            ).first()
        if row is None:
            return
        if not row.test:
            self.current = row.batch_id
        try:
            await self._submit(row.batch_id, row.idx)
        except Rejected as e:
            # That one fails; the next tick goes on with the same batch.
            await self._fail_request(row.batch_id, row.idx, e)
        except (ComfyUnreachable, ComfyError) as e:
            self._down(str(e))

    async def _fail_request(self, batch_id: int, idx: int, e: Rejected) -> None:
        first = e.node_errors[0] if e.node_errors else {}
        error = {
            "node": first.get("node", ""),
            "class_type": first.get("class_type"),
            "type": e.kind,
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
        """Build and send one request. Raises Rejected (ComfyRejected or
        GraphInvalid) / ComfyUnreachable."""
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
            raise GraphInvalid("Its workflow was deleted")
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
            raise GraphInvalid(str(e)) from e
        pnginfo = None
        # A graph saved before setup cleaned it may still hold NaN.
        graph = gen_metadata.sanitize_json(graph)
        if gen["kind"] != "builtin":
            info = await self._node_info()
            if info:
                drop_missing(
                    graph, {n["class_type"] for n in graph.values()} - set(info)
                )
                fill_defaults(graph, info)
            clear_display_text(graph)
            pnginfo = family_pnginfo(gen.get("source"))
        try:
            pid = await self.client.queue_prompt(graph, pnginfo)
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

    async def _node_info(self) -> dict[str, Any]:
        """ComfyUI's node classes and their inputs, read once per connection;
        empty when it won't say (then nothing is dropped or filled)."""
        if self._classes is None:
            assert self.client is not None
            try:
                self._classes = await self.client.node_info()
            except (ComfyError, ComfyUnreachable):
                return {}
        return self._classes

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

        plan = build_batch_inputs(body, gen, s, test=test)
        async with self._tick_lock:
            batch_id = await self._insert_and_submit(
                gen, plan, (body.get("name") or "").strip()
            )
        self._wake.set()
        return batch_id

    async def _insert_and_submit(
        self,
        gen: dict[str, Any],
        plan: BatchPlan,
        given: str,
    ) -> int:
        """Caller holds ``_tick_lock``, so the loop can't see the new pending
        rows (and submit them too) or a stale queue snapshot (and call the new
        prompt lost)."""
        b, r = t.generation_batches, t.generation_requests
        inputs = plan.inputs
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
            name = given or batch_name(
                number=batch_id,
                generator=gen["name"],
                characters=characters_of(inputs),
                extra=plan.name_words,
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
                    for i, (n, sd) in enumerate(zip(plan.sizes, plan.seeds))
                ],
            )
        # Sent now so ComfyUI checks the graph (a rejection keeps nothing),
        # then parked if other batches are ahead of it.
        try:
            pid = await self._submit(batch_id, 0)
        except Rejected:
            await self._delete_batch(batch_id)
            raise
        except (ComfyUnreachable, ComfyError) as e:
            await self._delete_batch(batch_id)
            self._down(str(e))
            raise Unavailable(str(e)) from e
        if inputs.get("test"):
            return batch_id
        if await self._has_unfinished(besides=batch_id):
            await self._park(batch_id, pid)
        else:
            self.current = batch_id
        return batch_id

    async def _park(self, batch_id: int, pid: str) -> None:
        """Take a batch's first request back out of ComfyUI's queue to wait
        its turn here. If ComfyUI has already started (or even finished) it,
        it stays and the poll loop follows it."""
        assert self.client is not None
        try:
            await self.client.delete_queued([pid])
        except (ComfyUnreachable, ComfyError) as e:
            # Still in ComfyUI's queue: it runs once out of turn.
            self._down(str(e))
            return
        try:
            running, _ = await self.client.queue()
            if pid in running or await self.client.history(pid) is not None:
                return
        except (ComfyUnreachable, ComfyError) as e:
            # Can't tell whether it ran first. Left as sent: at worst it's
            # called lost (and can be retried), never made twice.
            self._down(str(e))
            return
        r = t.generation_requests
        async with async_tx() as conn:
            await conn.execute(
                sa.update(r)
                .where(r.c.batch_id == batch_id, r.c.prompt_id == pid)
                .values(state="pending", prompt_id=None, queued_at=None)
            )

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
        body = {
            **replay_body(row.inputs),
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
        if req is None or req.state not in RETRYABLE:
            raise Invalid("Only a finished request can be retried")
        if req.state == "done" and outputs:
            # Its images are in the library; retrying would drop them from the batch.
            raise Invalid("This request returned images")
        async with async_tx() as conn:
            if single and (req.images or 0) > 1:
                await conn.execute(
                    sa.update(r).where(r.c._id == request_id).values(state=REPLACED)
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

    async def cancel(self, batch_id: int, request_id: int | None = None) -> bool:
        """Cancel a batch's unfinished requests, or just one of them. A whole
        batch cancelled before any of it ran leaves nothing to keep, so it is
        deleted; returns whether it was."""
        async with self._tick_lock:
            await self._cancel(batch_id, request_id)
            gone = request_id is None and not await self._ever_ran(batch_id)
            if gone:
                await self._delete_batch(batch_id)
        self._wake.set()
        return gone

    async def _ever_ran(self, batch_id: int) -> bool:
        """Some request of the batch may have run: it was sent to ComfyUI
        (the DB lags ComfyUI by a tick, so a sent one may be running already)
        or has a finished state. Parked requests were never sent."""
        r = t.generation_requests
        async with async_conn() as conn:
            row = (
                await conn.execute(
                    sa.select(r.c._id)
                    .where(
                        r.c.batch_id == batch_id,
                        sa.or_(
                            r.c.prompt_id.is_not(None),
                            r.c.state.not_in(("pending", "cancelled")),
                        ),
                    )
                    .limit(1)
                )
            ).first()
        return row is not None

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
