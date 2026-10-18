"""User extraction rules: per-workflow-signature rulesets that pin dot-paths for
generation fields. Rulesets are sig-global (not per-library); editing one
reprojects every image of that signature across all libraries.

See CONTEXT.md › Generation metadata, and plan-aiArtEnhancements-v2.md.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from ..services import gen_metadata
from ..services.image_tags import id_candidates
from ._utils import thumb_url

router = APIRouter()


class RulesetBody(BaseModel):
    fields: dict[str, list[str]] = {}


class PreviewBody(BaseModel):
    sample_image_id: str
    fields: dict[str, list[str]] = {}


def _ruleset_doc(sig: str, doc: dict) -> dict:
    """Reconstruct the public ruleset shape (id + stored fields/updated_at)."""
    return {"_id": sig, **(doc or {})}


@router.get("")
async def list_rulesets():
    async with async_conn() as conn:
        rows = (
            await conn.execute(sa.select(t.gen_rulesets.c.sig, t.gen_rulesets.c.doc))
        ).fetchall()
    return [_ruleset_doc(r.sig, r.doc) for r in rows]


@router.get("/signatures")
async def list_signatures():
    """Workflow signatures seen in the library, with image counts, how many still
    need mapping, a sample image to author against, and whether a ruleset exists.
    Drives the authoring UI's signature picker."""
    needs = sa.case((t.images.c.gen_prompt.is_(None), 1), else_=0)
    stmt = (
        sa.select(
            t.images.c.gen_workflow_sig.label("workflow_sig"),
            sa.func.count().label("count"),
            sa.func.sum(needs).label("needs_mapping"),
            sa.func.max(t.images.c._id).label("sample_image_id"),
        )
        .where(t.images.c.gen_workflow_sig.isnot(None))
        .group_by(t.images.c.gen_workflow_sig)
        .order_by(sa.text("needs_mapping DESC"), sa.text("count DESC"))
    )
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
        mapped = {
            r.sig
            for r in (await conn.execute(sa.select(t.gen_rulesets.c.sig))).fetchall()
        }
        # One sample per signature: its graph names the nodes (to describe the
        # workflow in words) and its model is the friendliest label we have.
        samples = [r.sample_image_id for r in rows]
        raw_by_id: dict[str, object] = {}
        model_by_id: dict[str, str | None] = {}
        if samples:
            for r in (
                await conn.execute(
                    sa.select(t.image_gen_raw.c._id, t.image_gen_raw.c.raw).where(
                        t.image_gen_raw.c._id.in_(samples)
                    )
                )
            ).fetchall():
                raw_by_id[r._id] = r.raw
            for r in (
                await conn.execute(
                    sa.select(t.images.c._id, t.images.c.gen_model).where(
                        t.images.c._id.in_(samples)
                    )
                )
            ).fetchall():
                model_by_id[r._id] = r.gen_model
    types_by_sig = {
        r.workflow_sig: gen_metadata.workflow_node_types(
            (raw_by_id.get(r.sample_image_id) or {}).get("prompt")
            if isinstance(raw_by_id.get(r.sample_image_id), dict)
            else None
        )
        for r in rows
    }
    described = gen_metadata.describe_signatures(types_by_sig)
    return [
        {
            "workflow_sig": r.workflow_sig,
            "count": r.count,
            "needs_mapping": int(r.needs_mapping or 0),
            "sample_image_id": r.sample_image_id,
            "has_ruleset": r.workflow_sig in mapped,
            "sample_thumb_url": thumb_url(r.sample_image_id),
            "model": model_by_id.get(r.sample_image_id),
            **described.get(r.workflow_sig, {"node_count": 0, "distinct": []}),
        }
        for r in rows
    ]


@router.get("/{sig}")
async def get_ruleset(sig: str):
    async with async_conn() as conn:
        doc = (
            await conn.execute(
                sa.select(t.gen_rulesets.c.doc).where(t.gen_rulesets.c.sig == sig)
            )
        ).scalar()
    if not doc:
        # A signature with no ruleset yet — return an empty editable shell.
        return {"_id": sig, "fields": {}}
    return _ruleset_doc(sig, doc)


@router.put("/{sig}")
async def put_ruleset(sig: str, body: RulesetBody):
    fields = gen_metadata.clean_rule_fields(body.fields)
    doc = {"fields": fields, "updated_at": time.time()}
    async with async_tx() as conn:
        stmt = sqlite_insert(t.gen_rulesets).values(sig=sig, doc=doc)
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.gen_rulesets.c.sig], set_={"doc": stmt.excluded.doc}
        )
        await conn.execute(stmt)
    # Re-derive gen.* for every image of this signature (sig-global).
    from ..services.reproject import reproject_by_sig_async

    reproject_by_sig_async(sig)
    return _ruleset_doc(sig, doc)


@router.delete("/{sig}")
async def delete_ruleset(sig: str):
    async with async_tx() as conn:
        await conn.execute(sa.delete(t.gen_rulesets).where(t.gen_rulesets.c.sig == sig))
    from ..services.reproject import reproject_by_sig_async

    reproject_by_sig_async(sig)
    return {"deleted": sig}


@router.post("/preview")
async def preview_ruleset(body: PreviewBody):
    """Resolve candidate rules against one sample image's raw, without saving.

    Returns the final ``gen`` (== what reproject would write) plus per-path
    resolution so the UI can show whether each pin fired."""
    async with async_conn() as conn:
        raw = None
        for candidate in id_candidates(body.sample_image_id):
            row = (
                await conn.execute(
                    sa.select(t.image_gen_raw.c.raw).where(
                        t.image_gen_raw.c._id == candidate
                    )
                )
            ).first()
            if row is not None:
                raw = row.raw
                break
    if not raw:
        raise HTTPException(status_code=404, detail="No generation data for image")

    fields = gen_metadata.clean_rule_fields(body.fields)
    gen = gen_metadata.extract(raw, {"fields": fields})
    paths = gen_metadata.resolve_ruleset_paths(raw, fields)
    # A pin resolving to a non-finite float (NaN/Infinity) would 500 on render.
    return gen_metadata.sanitize_json({"gen": gen, "paths": paths})
