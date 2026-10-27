"""User extraction rules: per-workflow-signature rulesets that pin dot-paths for
generation fields. Rulesets are sig-global (not per-library); editing one
reprojects every image of that signature across all libraries.

See CONTEXT.md › Generation metadata, and plan-aiArtEnhancements-v2.md.
"""

from __future__ import annotations

import json
import time
from collections import Counter

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from ..services import extraction_settings, gen_metadata, reproject, workflow_family
from ..services import workflow_identity
from ..services import image_tags
from ..services import thumb_version

router = APIRouter()


class RulesetBody(BaseModel):
    fields: dict[str, list[str]] = {}


class GuessKeywordsBody(BaseModel):
    guess_positive: list[str]
    guess_negative: list[str]


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


class WorkflowNameBody(BaseModel):
    name: str = ""


@router.put("/workflows/{workflow_id}/name")
async def put_workflow_name(workflow_id: str, body: WorkflowNameBody):
    """Name a workflow family (every image whose editor graph has this id).
    An empty name clears it, falling back to imported filenames."""
    name = body.name.strip()[:120]
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
    return {"workflow_id": workflow_id, "name": name or None}


class WorkflowFileBody(BaseModel):
    workflow_id: str
    filename: str
    node_types: list[str]


@router.post("/workflow-files")
async def import_workflow_files(files: list[WorkflowFileBody]):
    """Record saved ComfyUI workflow files: id, filename and editor node types
    only (the browser reads the file; nothing else is uploaded). Re-importing
    a filename replaces its node types. Returns how many families matched an
    image already in the library, and their ids (so a client importing in
    batches can count distinct workflows across them)."""
    rows = [
        {
            "workflow_id": f.workflow_id.strip(),
            "filename": f.filename.strip()[:200],
            "node_types": [str(x)[:200] for x in f.node_types[:2000]],
            "imported_at": time.time(),
        }
        for f in files[:500]
        if f.workflow_id.strip() and f.filename.strip()
    ]
    if not rows:
        return {"imported": 0, "known": 0, "known_ids": []}
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
    # Which of these ids appear on images at all (cheap: one sample per sig).
    sigs = await list_signatures()
    seen = {s["workflow_id"] for s in sigs if s["workflow_id"]}
    known_ids = sorted({r["workflow_id"] for r in rows} & seen)
    return {"imported": len(rows), "known": len(known_ids), "known_ids": known_ids}


@router.get("/guess-keywords")
async def get_guess_keywords():
    return await extraction_settings.get_settings()


@router.put("/guess-keywords")
async def put_guess_keywords(body: GuessKeywordsBody):
    """Save the prompt-guessing keywords and re-derive every image's ``gen.*``
    in the background (any prompt-less graph may now guess differently)."""
    try:
        await extraction_settings.set_keywords(body.guess_positive, body.guess_negative)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    reproject.reproject_all_async()
    return await extraction_settings.get_settings()


@router.get("/{sig}")
async def get_ruleset(sig: str):
    async with async_conn() as conn:
        doc = (
            await conn.execute(
                sa.select(t.gen_rulesets.c.doc).where(t.gen_rulesets.c.sig == sig)
            )
        ).scalar()
    if not doc:
        # A signature with no ruleset yet: return an empty editable shell.
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
        image_id = await image_tags.resolve_image_id(conn, body.sample_image_id)
        raw = None
        if image_id is not None:
            raw = (
                await conn.execute(
                    sa.select(t.image_gen_raw.c.raw).where(
                        t.image_gen_raw.c._id == image_id
                    )
                )
            ).scalar()
    if not raw:
        raise HTTPException(status_code=404, detail="No generation data for image")

    fields = gen_metadata.clean_rule_fields(body.fields)
    gen = gen_metadata.derive(raw, {"fields": fields}, await extraction_settings.load())
    paths = gen_metadata.resolve_ruleset_paths(raw, fields)
    # A pin resolving to a non-finite float (NaN/Infinity) would 500 on render.
    return gen_metadata.sanitize_json({"gen": gen, "paths": paths})
