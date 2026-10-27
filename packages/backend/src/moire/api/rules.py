"""User extraction rules: per-workflow-signature rulesets that pin dot-paths for
generation fields. Rulesets are sig-global (not per-library); editing one
reprojects every image of that signature across all libraries.

See CONTEXT.md › Generation metadata, and plan-aiArtEnhancements-v2.md.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database.db import async_conn
from ..services import extraction_settings, gen_metadata, gen_raw, reproject
from ..services import rulesets, workflow_signatures

router = APIRouter()


class RulesetBody(BaseModel):
    fields: dict[str, list[str]] = {}


class GuessKeywordsBody(BaseModel):
    guess_positive: list[str]
    guess_negative: list[str]


class PreviewBody(BaseModel):
    sample_image_id: str
    fields: dict[str, list[str]] = {}


@router.get("")
async def list_rulesets():
    return await rulesets.list_all()


@router.get("/signatures")
async def list_signatures():
    """Workflow signatures seen in the library, with image counts, how many still
    need mapping, a sample image to author against, and whether a ruleset exists.
    Drives the authoring UI's signature picker."""
    return await workflow_signatures.list_signatures()


class WorkflowNameBody(BaseModel):
    name: str = ""


@router.put("/workflows/{workflow_id}/name")
async def put_workflow_name(workflow_id: str, body: WorkflowNameBody):
    """Name a workflow family (every image whose editor graph has this id).
    An empty name clears it, falling back to imported filenames."""
    name = body.name.strip()[:120]
    await workflow_signatures.set_workflow_name(workflow_id, name)
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
    known_ids = await workflow_signatures.save_workflow_files(rows)
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
    return await rulesets.get(sig)


@router.put("/{sig}")
async def put_ruleset(sig: str, body: RulesetBody):
    return await rulesets.put(sig, body.fields)


@router.delete("/{sig}")
async def delete_ruleset(sig: str):
    await rulesets.delete(sig)
    return {"deleted": sig}


@router.post("/preview")
async def preview_ruleset(body: PreviewBody):
    """Resolve candidate rules against one sample image's raw, without saving.

    Returns the final ``gen`` (== what reproject would write) plus per-path
    resolution so the UI can show whether each pin fired."""
    async with async_conn() as conn:
        raw = await gen_raw.raw_for(conn, body.sample_image_id)
    if not raw:
        raise HTTPException(status_code=404, detail="No generation data for image")

    fields = gen_metadata.clean_rule_fields(body.fields)
    gen = gen_metadata.derive(raw, {"fields": fields}, await extraction_settings.load())
    paths = gen_metadata.resolve_ruleset_paths(raw, fields)
    # A pin resolving to a non-finite float (NaN/Infinity) would 500 on render.
    return gen_metadata.sanitize_json({"gen": gen, "paths": paths})
