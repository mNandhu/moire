"""Workflow signatures seen in the library, and the names and saved files that
label their families.

The Rules page's signature picker reads :func:`list_signatures`; naming a
family and importing saved workflow files write the two label tables here.
Family membership and labelling rules live in :mod:`services.workflow_family`.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from collections.abc import Iterable
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import schema as t
from ..database.db import async_conn, async_tx
from . import thumb_version, workflow_family, workflow_identity


async def list_signatures() -> list[dict[str, Any]]:
    """Workflow signatures seen in the library, with image counts, how many still
    need mapping, a sample image to author against, and whether a ruleset exists.
    Drives the authoring UI's signature picker."""
    needs = sa.case((t.images.c.gen_prompt.is_(None), 1), else_=0)
    guessed = sa.case(
        (sa.func.json_extract(t.images.c.gen, "$.guessed[0]") == "prompt", 1),
        else_=0,
    )
    stmt = (
        sa.select(
            t.images.c.gen_workflow_sig.label("workflow_sig"),
            sa.func.count().label("count"),
            sa.func.sum(needs).label("needs_mapping"),
            sa.func.sum(guessed).label("guessed"),
            # The same sample the gallery's workflow filter keys on.
            workflow_family.SAMPLE_ID.label("sample_image_id"),
            # When the version was in use (file mtimes, i.e. generation time):
            # the human way to tell apart versions that differ only by small
            # helper edits.
            sa.func.min(t.images.c.mtime).label("first_used"),
            sa.func.max(t.images.c.mtime).label("last_used"),
        )
        .where(t.images.c.gen_workflow_sig.isnot(None))
        .group_by(t.images.c.gen_workflow_sig)
        .order_by(
            sa.text("needs_mapping DESC"),
            sa.text("guessed DESC"),
            sa.text("count DESC"),
        )
    )

    def _json(text: object) -> object:
        try:
            return json.loads(text) if isinstance(text, str) else None
        except ValueError:
            return None

    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
        mapped = {
            r.sig
            for r in (await conn.execute(sa.select(t.gen_rulesets.c.sig))).fetchall()
        }
        # One sample per signature: its graphs name the nodes (to describe the
        # workflow in words), its editor-graph `id` places it in a workflow
        # family, and its model is a fallback label. json_extract pulls just
        # those parts of `raw`, never the whole document.
        samples = [r.sample_image_id for r in rows]
        sample_by_id: dict[str, sa.Row] = {}
        if samples:
            raw = t.image_gen_raw.c.raw
            stmt = (
                sa.select(
                    t.images.c._id,
                    t.images.c.gen_model,
                    sa.func.json_extract(raw, "$.prompt").label("prompt"),
                    workflow_family.WORKFLOW_ID.label("workflow_id"),
                    sa.func.json_extract(raw, "$.workflow.nodes").label("ui_nodes"),
                )
                .select_from(
                    t.images.outerjoin(
                        t.image_gen_raw, t.image_gen_raw.c._id == t.images.c._id
                    )
                )
                .where(t.images.c._id.in_(samples))
            )
            for r in (await conn.execute(stmt)).fetchall():
                sample_by_id[r._id] = r
        family_ids = {
            r.workflow_id
            for r in sample_by_id.values()
            if isinstance(r.workflow_id, str)
        }
        names, files = await workflow_family.family_records(conn, family_ids)

    def _prompt_graph(image_id: str) -> dict | None:
        s = sample_by_id.get(image_id)
        graph = _json(s.prompt) if s is not None else None
        return graph if isinstance(graph, dict) else None

    types_by_sig = {
        r.workflow_sig: workflow_identity.workflow_node_types(
            _prompt_graph(r.sample_image_id)
        )
        for r in rows
    }
    described = workflow_identity.describe_signatures(types_by_sig)
    thumbs = await thumb_version.urls(r.sample_image_id for r in rows)

    def _family(image_id: str) -> dict:
        s = sample_by_id.get(image_id)
        wid = (
            s.workflow_id if s is not None and isinstance(s.workflow_id, str) else None
        )
        # Matched per sample, so versions of one family can match different files.
        lab = (
            workflow_family.label(
                names.get(wid),
                files.get(wid),
                _json(s.ui_nodes) if s is not None else None,
            )
            if wid
            else {"name": None, "file_name": None, "file_match": None}
        )
        return {
            "workflow_id": wid,
            "workflow_name": lab["name"],
            "file_name": lab["file_name"],
            "file_match": lab["file_match"],
        }

    return [
        {
            "workflow_sig": r.workflow_sig,
            "count": r.count,
            "needs_mapping": int(r.needs_mapping or 0),
            # Prompt found only by keyword guessing (services/prompt_guess.py).
            "guessed": int(r.guessed or 0),
            "sample_image_id": r.sample_image_id,
            "has_ruleset": r.workflow_sig in mapped,
            "first_used": r.first_used,
            "last_used": r.last_used,
            "sample_thumb_url": thumbs.get(r.sample_image_id),
            "model": (
                sample_by_id[r.sample_image_id].gen_model
                if r.sample_image_id in sample_by_id
                else None
            ),
            **described.get(r.workflow_sig, {"node_count": 0, "distinct": []}),
            # Full node-type counts, so the UI can say what a version does
            # (starts from an image, fixes faces, upscales...) on its own terms.
            "node_types": dict(
                Counter(ty for ty in types_by_sig[r.workflow_sig] if ty)
            ),
            **_family(r.sample_image_id),
        }
        for r in rows
    ]


async def known_workflow_ids(conn: AsyncConnection, ids: Iterable[str]) -> set[str]:
    """Which of ``ids`` name the family of some signature's sample image (the
    same samples :func:`list_signatures` reports), in one query."""
    wanted = set(ids)
    if not wanted:
        return set()
    stmt = (
        sa.select(workflow_family.WORKFLOW_ID)
        .select_from(
            t.images.join(t.image_gen_raw, t.image_gen_raw.c._id == t.images.c._id)
        )
        .where(
            t.images.c._id.in_(workflow_family.sample_ids()),
            workflow_family.WORKFLOW_ID.in_(wanted),
        )
        .distinct()
    )
    return {r[0] for r in (await conn.execute(stmt)).fetchall()}


async def set_workflow_name(workflow_id: str, name: str) -> None:
    """Name a workflow family; an empty name clears it."""
    async with async_tx() as conn:
        if not name:
            await conn.execute(
                sa.delete(t.workflow_names).where(
                    t.workflow_names.c.workflow_id == workflow_id
                )
            )
        else:
            stmt = sqlite_insert(t.workflow_names).values(
                workflow_id=workflow_id, name=name, updated_at=time.time()
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=[t.workflow_names.c.workflow_id],
                set_={
                    "name": stmt.excluded.name,
                    "updated_at": stmt.excluded.updated_at,
                },
            )
            await conn.execute(stmt)


async def save_workflow_files(rows: list[dict[str, Any]]) -> list[str]:
    """Upsert imported workflow files (``workflow_id``, ``filename``,
    ``node_types``, ``imported_at``); re-importing a filename replaces its
    node types. Returns the sorted ids among them already seen on an image."""
    async with async_tx() as conn:
        stmt = sqlite_insert(t.workflow_files).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[
                t.workflow_files.c.workflow_id,
                t.workflow_files.c.filename,
            ],
            set_={
                "node_types": stmt.excluded.node_types,
                "imported_at": stmt.excluded.imported_at,
            },
        )
        await conn.execute(stmt)
    async with async_conn() as conn:
        known = await known_workflow_ids(conn, (r["workflow_id"] for r in rows))
    return sorted(known)
