"""The Generator test gate: a Generator is ready to queue only after its test
run's image reached the library. :func:`start_test` queues the run;
:func:`settle_tests` flips ``ready`` once the image is there (the manager's
tick calls it, and queueing settles its own Generator first)."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import comfy_models, generation_batches
from .generation_errors import Invalid, Unavailable
from .generators_store import load_generator

if TYPE_CHECKING:
    from .generation_jobs import GenerationManager


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


def _arrived(batch_id):
    """Some output of the test batch is in the library (what
    ``generation_batches.test_status`` reports as its ``image_id``)."""
    return generation_batches.arrived_outputs(batch_id).exists()


async def settle_tests(generator_id: str | None = None) -> None:
    """Mark ready each Generator (or just ``generator_id``) whose test run's
    image has reached the library."""
    g = t.generators
    batch = g.c.test["batch_id"].as_integer()
    where = [sa.not_(g.c.ready), batch.isnot(None), _arrived(batch)]
    if generator_id is not None:
        where.append(g.c._id == generator_id)
    # Read first so an idle tick takes no write lock. The update checks it
    # all again: a save or a new test since the read leaves it not ready.
    async with async_conn() as conn:
        due = (await conn.execute(sa.select(g.c._id).where(*where).limit(1))).first()
    if due is not None:
        async with async_tx() as conn:
            await conn.execute(sa.update(g).where(*where).values(ready=True))
