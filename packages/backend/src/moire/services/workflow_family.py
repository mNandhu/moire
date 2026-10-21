"""Workflow families: which signatures belong to which saved workflow.

A family is every signature whose *sample image* embeds an editor graph with
the same top-level ``id`` (ComfyUI keeps it across edits, copies and Save As).
The Rules page groups signatures by it and the gallery filters by it; both go
through this module so the two can never disagree about what a family holds.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import schema as t

# The sample image of a signature, used as an aggregate over its images: the
# newest by id. One image stands for the whole signature everywhere.
SAMPLE_ID = sa.func.max(t.images.c._id)

# A raw generation document's editor-graph id (the family key); an image
# Moire queued carries it in its own chunk instead (no editor workflow).
WORKFLOW_ID = sa.func.coalesce(
    sa.func.json_extract(t.image_gen_raw.c.raw, "$.workflow.id"),
    sa.func.json_extract(t.image_gen_raw.c.raw, "$.moire.family"),
)


async def family_sigs(conn: AsyncConnection, workflow_id: str) -> tuple[str, ...]:
    """Every signature in the family ``workflow_id``. One GROUP BY over the
    signature index plus a json_extract per signature's sample, not per image."""
    samples = (
        sa.select(SAMPLE_ID)
        .where(t.images.c.gen_workflow_sig.isnot(None))
        .group_by(t.images.c.gen_workflow_sig)
    )
    stmt = (
        sa.select(t.images.c.gen_workflow_sig)
        .join(t.image_gen_raw, t.image_gen_raw.c._id == t.images.c._id)
        .where(t.images.c._id.in_(samples), WORKFLOW_ID == workflow_id)
    )
    return tuple(r[0] for r in (await conn.execute(stmt)).fetchall())
