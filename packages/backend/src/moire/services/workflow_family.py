"""Workflow families: which signatures belong to which saved workflow.

A family is every signature whose *sample image* embeds an editor graph with
the same top-level ``id`` (ComfyUI keeps it across edits, copies and Save As).
The Rules page groups signatures by it and the gallery filters by it; both go
through this module so the two can never disagree about what a family holds.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import schema as t
from . import workflow_identity

# The sample image of a signature, used as an aggregate over its images: the
# newest by id. One image stands for the whole signature everywhere.
SAMPLE_ID = sa.func.max(t.images.c._id)

# A raw generation document's editor-graph id (the family key); an image
# Moire queued carries it in its own chunk instead (no editor workflow).
# An empty editor id counts as none.
WORKFLOW_ID = sa.func.coalesce(
    sa.func.nullif(sa.func.json_extract(t.image_gen_raw.c.raw, "$.workflow.id"), ""),
    sa.func.json_extract(t.image_gen_raw.c.raw, "$.moire.family"),
)


def sample_ids() -> sa.Select:
    """The sample image id of every signature (one GROUP BY over the index)."""
    return (
        sa.select(SAMPLE_ID)
        .where(t.images.c.gen_workflow_sig.isnot(None))
        .group_by(t.images.c.gen_workflow_sig)
    )


async def family_sigs(conn: AsyncConnection, workflow_id: str) -> tuple[str, ...]:
    """Every signature in the family ``workflow_id``. One GROUP BY over the
    signature index plus a json_extract per signature's sample, not per image."""
    stmt = (
        sa.select(t.images.c.gen_workflow_sig)
        .join(t.image_gen_raw, t.image_gen_raw.c._id == t.images.c._id)
        .where(t.images.c._id.in_(sample_ids()), WORKFLOW_ID == workflow_id)
    )
    return tuple(r[0] for r in (await conn.execute(stmt)).fetchall())


def family_key(raw: Any) -> str | None:
    """The Python twin of ``WORKFLOW_ID``: the editor graph's ``workflow.id``,
    else the id in Moire's own chunk, if it is a string."""
    if not isinstance(raw, dict):
        return None
    workflow = raw.get("workflow")
    key = workflow.get("id") if isinstance(workflow, dict) else None
    if key is None or key == "":
        moire = raw.get("moire")
        key = moire.get("family") if isinstance(moire, dict) else None
    return key if isinstance(key, str) else None


FileList = list[tuple[str, list[str]]]


async def family_records(
    conn: AsyncConnection, family_ids: Iterable[str]
) -> tuple[dict[str, str], dict[str, FileList]]:
    """The saved names and imported workflow files of the families, in two
    batched queries: ({family_id: name}, {family_id: [(filename, node_types)]})."""
    ids = set(family_ids)
    names: dict[str, str] = {}
    files: dict[str, FileList] = {}
    if not ids:
        return names, files
    wn, wf = t.workflow_names, t.workflow_files
    for r in (
        await conn.execute(sa.select(wn).where(wn.c.workflow_id.in_(ids)))
    ).fetchall():
        names[r.workflow_id] = r.name
    for r in (
        await conn.execute(
            sa.select(wf.c.workflow_id, wf.c.filename, wf.c.node_types).where(
                wf.c.workflow_id.in_(ids)
            )
        )
    ).fetchall():
        files.setdefault(r.workflow_id, []).append(
            (r.filename, list(r.node_types or []))
        )
    return names, files


def label(name: str | None, files: FileList | None, ui_nodes: Any) -> dict[str, Any]:
    """One family's label: its saved name, and the imported file the sample's
    editor nodes match best (``file_match`` 0..1, rounded). Pure."""
    match = None
    if files:
        match = workflow_identity.match_workflow_file(
            workflow_identity.editor_node_types(
                {"nodes": ui_nodes} if isinstance(ui_nodes, list) else None
            ),
            files,
        )
    return {
        "name": name,
        "file_name": match[0] if match else None,
        "file_match": round(match[1], 3) if match else None,
    }


async def family_labels(
    conn: AsyncConnection,
    family_ids: Iterable[str],
    ui_nodes_by_family: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    """``{family_id: {name, file_name, file_match}}`` for families that each
    have one sample (``ui_nodes_by_family``: its ``workflow.nodes``). A caller
    that matches several samples of one family (the Rules page, one per
    signature) uses ``family_records`` and ``label`` directly."""
    ids = set(family_ids)
    names, files = await family_records(conn, ids)
    return {
        fid: label(names.get(fid), files.get(fid), ui_nodes_by_family.get(fid))
        for fid in ids
    }
