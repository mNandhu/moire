"""Read side of generation: batch list, batch detail, and the Generator test
gate. Outputs are joined to ``images`` here, so "waiting for scan" is simply an
output whose image row doesn't exist yet.
"""

from __future__ import annotations

import time
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import comfy_models, generation_estimate, generator_setup
from .generation_jobs import GenerationManager, Invalid, Unavailable, load_generator
from .generator_discovery import fixed_values
from .generator_graph import sampling_defaults, slot_value

_b, _r, _o, _i = (
    t.generation_batches,
    t.generation_requests,
    t.generation_outputs,
    t.images,
)

# Requests the UI shows: a request split by "Retry one at a time" is replaced
# by its singles.
_VISIBLE = _r.c.state != "replaced"
# How long a finished request's missing output counts as still arriving.
ARRIVING_SECONDS = 300


def batch_state(states: list[str], connected: bool) -> str:
    """running / paused (ComfyUI down mid-batch) / done / failed (some
    requests failed or were lost) / cancelled. Pure."""
    if not states:
        return "done"
    if any(s in ("pending", "queued", "running") for s in states):
        return "running" if connected else "paused"
    if all(s == "cancelled" for s in states):
        return "cancelled"
    if any(s in ("failed", "lost") for s in states):
        return "failed"
    return "done"


async def _outputs(conn, reqs: list[Any]) -> dict[int, list[dict[str, Any]]]:
    """Each request's outputs. ``arriving``: made, not in the library yet
    (downloading or waiting for the scan), for a while after the request
    finished; past that, a missing one was deleted."""
    if not reqs:
        return {}
    request_ids = [q._id for q in reqs]
    recent = time.time() - ARRIVING_SECONDS
    fresh = {q._id for q in reqs if (q.finished_at or 0) > recent}
    rows = (
        await conn.execute(
            sa.select(
                _o.c.request_id,
                _o.c.idx,
                _o.c.image_id,
                _o.c.filename,
                _i.c._id.label("found"),
                _i.c.quarantined,
                _i.c.score,
                _i.c.width,
                _i.c.height,
            )
            .select_from(_o.outerjoin(_i, _i.c._id == _o.c.image_id))
            .where(_o.c.request_id.in_(request_ids))
            .order_by(_o.c.request_id, _o.c.idx)
        )
    ).fetchall()
    out: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        out.setdefault(row.request_id, []).append(
            {
                "idx": row.idx,
                "image_id": row.image_id,
                "filename": row.filename,
                "in_library": row.found is not None,
                "arriving": row.found is None and row.request_id in fresh,
                "quarantined": bool(row.quarantined),
                "score": row.score,
                "width": row.width,
                "height": row.height,
            }
        )
    return out


async def get_batch(batch_id: int, manager: GenerationManager) -> dict[str, Any] | None:
    async with async_conn() as conn:
        batch = (await conn.execute(sa.select(_b).where(_b.c._id == batch_id))).first()
        if batch is None:
            return None
        reqs = (
            await conn.execute(
                sa.select(_r)
                .where(_r.c.batch_id == batch_id, _VISIBLE)
                .order_by(_r.c.idx)
            )
        ).fetchall()
        outputs = await _outputs(conn, reqs)
        ran = dict(
            (
                await conn.execute(
                    sa.select(
                        t.generation_run_times.c.request_id,
                        t.generation_run_times.c.seconds,
                    ).where(
                        t.generation_run_times.c.request_id.in_([q._id for q in reqs])
                    )
                )
            ).fetchall()
        )
    gen = await load_generator(batch.generator_id)
    unfinished = any(q.state in ("pending", "queued", "running") for q in reqs)
    expected = (
        (await generation_estimate.queue_plan(manager.started))["requests"]
        if unfinished
        else {}
    )
    requests = []
    for q in reqs:
        requests.append(
            {
                "_id": q._id,
                "idx": q.idx,
                "state": q.state,
                "seed": q.seed,
                "images": q.images,
                "error": q.error,
                "progress": manager.progress.get(q.prompt_id) if q.prompt_id else None,
                "queued_at": q.queued_at,
                "finished_at": q.finished_at,
                # Seconds ComfyUI spent on it; None before it ends.
                "ran": ran.get(q._id),
                # Before it ends: the seconds it should take (None without
                # history), and how long ComfyUI has been running it (None
                # until it starts; seconds, so the client's clock doesn't matter).
                "expected": expected.get(q._id),
                "elapsed": manager.running_for(q.prompt_id),
                "outputs": outputs.get(q._id, []),
            }
        )
    return {
        "_id": batch._id,
        "name": batch.name,
        "auto_name": batch.auto_name,
        "generator": {"_id": batch.generator_id, "name": gen["name"] if gen else None},
        "inputs": batch.inputs,
        "created_at": batch.created_at,
        "state": batch_state([q["state"] for q in requests], manager.connected),
        "requests": requests,
    }


async def list_batches(
    manager: GenerationManager, *, limit: int = 50, before: int | None = None
) -> list[dict[str, Any]]:
    q = sa.select(_b).order_by(_b.c._id.desc()).limit(limit)
    # Test runs are the gate's business, not history.
    q = q.where(sa.func.coalesce(sa.func.json_extract(_b.c.inputs, "$.test"), 0) == 0)
    if before is not None:
        q = q.where(_b.c._id < before)
    async with async_conn() as conn:
        batches = (await conn.execute(q)).fetchall()
        ids = [b._id for b in batches]
        reqs = (
            (
                await conn.execute(
                    sa.select(
                        _r.c._id,
                        _r.c.batch_id,
                        _r.c.state,
                        _r.c.images,
                        _r.c.finished_at,
                    ).where(_r.c.batch_id.in_(ids), _VISIBLE)
                )
            ).fetchall()
            if ids
            else []
        )
        outputs = await _outputs(conn, reqs)
    by_batch: dict[int, list[Any]] = {}
    for q in reqs:
        by_batch.setdefault(q.batch_id, []).append(q)
    names: dict[str, str | None] = {}
    out = []
    for b in batches:
        if b.generator_id not in names:
            g = await load_generator(b.generator_id)
            names[b.generator_id] = g["name"] if g else None
        rs = by_batch.get(b._id, [])
        outs = [o for q in rs for o in outputs.get(q._id, [])]
        out.append(
            {
                "_id": b._id,
                "name": b.name,
                "generator": names[b.generator_id],
                "created_at": b.created_at,
                "width": b.inputs.get("width"),
                "height": b.inputs.get("height"),
                "state": batch_state([q.state for q in rs], manager.connected),
                "requests": len(rs),
                "failed": sum(1 for q in rs if q.state in ("failed", "lost")),
                "images": len(outs),
                "kept": sum(
                    1 for o in outs if o["in_library"] and not o["quarantined"]
                ),
                "arriving": sum(1 for o in outs if o["arriving"]),
                "thumbs": [o["image_id"] for o in outs if o["in_library"]][:12],
            }
        )
    return out


async def rename(batch_id: int, name: str) -> bool:
    name = name.strip()
    if not name:
        return False
    async with async_tx() as conn:
        res = await conn.execute(
            sa.update(_b).where(_b.c._id == batch_id).values(name=name, auto_name=False)
        )
    return bool(res.rowcount)


# -- Generator test gate ----------------------------------------------------------


async def start_test(
    manager: GenerationManager, generator_id: str, checkpoint: str | None
) -> int:
    """Queue the Generator's test run: one image, with one installed LoRA
    chained at strength 0 so a bad insertion point fails here."""
    gen = await load_generator(generator_id)
    if gen is None:
        raise Invalid("Unknown workflow")
    # Connecting loads the model index the first time; read it after.
    if not await manager.check():
        raise Unavailable("Can't reach ComfyUI")
    installed = await comfy_models.installed()
    # Only where Moiré can splice one in: a graph without an insertion point
    # takes no LoRAs at all.
    loras = (
        [{"name": installed["lora"][0], "strength": 0.0}]
        if installed["lora"] and gen["slots"].get("lora_model")
        else []
    )
    defaults = (gen.get("source") or {}).get("defaults") or {}
    batch_id = await manager.queue_batch(
        {
            "generator_id": generator_id,
            # A custom Generator's own prompt: the test runs what it will run.
            "base": defaults.get("base") or "1girl, solo, simple background",
            "negative_base": defaults.get("negative") or "",
            "checkpoint": checkpoint
            or (installed["checkpoint"][0] if installed["checkpoint"] else None),
            "loras": loras,
            "count": 1,
            "name": "Test run",
        },
        test=True,
    )
    async with async_tx() as conn:
        await conn.execute(
            sa.update(t.generators)
            .where(t.generators.c._id == generator_id)
            .values(
                test={"batch_id": batch_id, "started_at": time.time()},
                ready=False,
                updated_at=time.time(),
            )
        )
    return batch_id


def _checkpoint_default(gen: dict[str, Any]) -> str | None:
    value = slot_value(gen["graph"], gen["slots"].get("checkpoint"))
    return value if isinstance(value, str) else None


async def generator_view(
    manager: GenerationManager, generator_id: str
) -> dict[str, Any] | None:
    """The Generator plus its test status; flips ``ready`` once the test's
    image is in the library."""
    gen = await load_generator(generator_id)
    if gen is None:
        return None
    test = None
    if gen.get("test") and gen["test"].get("batch_id"):
        batch = await get_batch(int(gen["test"]["batch_id"]), manager)
        if batch is not None:
            outs = [o for q in batch["requests"] for o in q["outputs"]]
            found = next((o["image_id"] for o in outs if o["in_library"]), None)
            req = batch["requests"][0] if batch["requests"] else None
            test = {
                "batch_id": batch["_id"],
                "state": req["state"] if req else "done",
                "error": req["error"] if req else None,
                "progress": req["progress"] if req else None,
                "outputs": len(outs),
                "image_id": found,
            }
            if found and not gen["ready"]:
                async with async_tx() as conn:
                    await conn.execute(
                        sa.update(t.generators)
                        .where(t.generators.c._id == generator_id)
                        .values(ready=True)
                    )
                gen["ready"] = True
    source = gen.get("source") or {}
    return {
        "_id": gen["_id"],
        "name": gen["name"],
        "kind": gen["kind"],
        "ready": bool(gen["ready"]),
        "slots": gen["slots"],
        # Where a custom one came from, and its default Base / negative.
        "source": generator_setup.public_source(source) or None,
        "defaults": source.get("defaults"),
        # What each exposed sampling setting is when left alone.
        "sampling": sampling_defaults(gen["graph"], gen["slots"]),
        # What the workflow sets itself where there's no slot (shown read-only).
        "fixed": fixed_values(gen["graph"], gen["slots"]),
        # The checkpoint slot's own value: what a remix into it starts on.
        "checkpoint_default": _checkpoint_default(gen),
        "test": test,
    }


async def active_summary(manager: GenerationManager) -> list[dict[str, Any]]:
    """The queue card: every batch with work left, oldest first. Images count
    what was asked (None per request when batch_size is unknown)."""
    async with async_conn() as conn:
        batches = (
            await conn.execute(
                sa.select(_b.c._id, _b.c.name, _b.c.inputs)
                .where(_b.c.state == "active")
                .order_by(_b.c._id)
            )
        ).fetchall()
        ids = [b._id for b in batches]
        reqs = (
            (
                await conn.execute(
                    sa.select(
                        _r.c.batch_id, _r.c.state, _r.c.images, _r.c.prompt_id
                    ).where(_r.c.batch_id.in_(ids), _VISIBLE)
                )
            ).fetchall()
            if ids
            else []
        )
    by_batch: dict[int, list[Any]] = {}
    for q in reqs:
        by_batch.setdefault(q.batch_id, []).append(q)
    out = []
    for b in batches:
        rs = by_batch.get(b._id, [])
        current = next((q for q in rs if q.state == "running"), None)
        out.append(
            {
                "_id": b._id,
                "name": b.name,
                "test": bool(b.inputs.get("test")),
                "state": batch_state([q.state for q in rs], manager.connected),
                "requests": len(rs),
                "finished": sum(
                    1 for q in rs if q.state not in ("pending", "queued", "running")
                ),
                "failed": sum(1 for q in rs if q.state in ("failed", "lost")),
                "progress": manager.progress.get(current.prompt_id)
                if current is not None and current.prompt_id
                else None,
            }
        )
    return out
