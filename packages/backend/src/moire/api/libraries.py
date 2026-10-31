from fastapi import APIRouter, HTTPException
import anyio  # type: ignore[import-not-found]

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from ..models.library import (
    LibraryDiscoverIn,
    LibraryIn,
    LibraryUpdate,
)
from ..models.responses import LibraryRow, documents
from ..services import library_discover, library_ops
from ..services.scanner import scan_library_async

router = APIRouter()


@router.get("", **documents(list[LibraryRow]))
async def list_libraries():
    return await library_ops.listing()


@router.post("/discover")
async def discover_libraries(body: LibraryDiscoverIn):
    """Dry run for the Add Library dialog: the libraries that adding `paths`
    would create (optionally one per immediate subfolder), with image counts and
    conflicts against registered libraries. Writes nothing."""
    async with async_conn() as conn:
        existing = (await conn.execute(sa.select(t.libraries.c.path))).scalars().all()
    reports = await anyio.to_thread.run_sync(  # type: ignore[attr-defined]
        lambda: library_discover.discover(
            body.paths, split_subdirs=body.split_subdirs, existing_paths=existing
        )
    )
    return {"sources": library_discover.as_dicts(reports)}


@router.post("")
async def add_library(body: LibraryIn):
    try:
        return await library_ops.create(body.path, body.name)
    except library_ops.BadPath as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{library_id}")
async def remove_library(library_id: str):
    await library_ops.remove(library_id)
    return {"removed": library_id}


@router.post("/{library_id}/rescan")
async def rescan_library(library_id: str):
    path = await library_ops.path_of(library_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Library not found")
    scan_library_async(library_id, path)
    return {"rescan": library_id, "started": True}


@router.post("/{library_id}/reproject")
async def reproject_library_endpoint(library_id: str):
    """Re-derive structured gen.* for a library from stored raw (no disk rescan)."""
    async with async_conn() as conn:
        found = (
            await conn.execute(
                sa.select(t.libraries.c._id).where(t.libraries.c._id == library_id)
            )
        ).scalar()
    if found is None:
        raise HTTPException(status_code=404, detail="Library not found")
    from ..services.reproject import reproject_library_async

    reproject_library_async(library_id)
    return {"reproject": library_id, "started": True}


@router.patch("/{library_id}")
async def update_library(library_id: str, body: LibraryUpdate):
    update_doc = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    if not update_doc:
        raise HTTPException(status_code=400, detail="No fields to update")
    try:
        return await library_ops.update(library_id, update_doc)
    except library_ops.BadPath as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except library_ops.NotFound as e:
        raise HTTPException(status_code=404, detail="Library not found") from e
