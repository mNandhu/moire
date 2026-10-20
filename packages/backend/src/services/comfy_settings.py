"""The "comfyui" settings row: address, optional headers, output library,
built-in images per request. Headers stay server-side; the API returns their
names with masked values, and a masked value on update keeps the stored one.
"""

from __future__ import annotations

import os
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t

ROW_ID = "comfyui"
MASK = "••••"

DEFAULT_COMFY_SETTINGS: dict[str, Any] = {
    "address": "",
    "headers": {},
    "output_library_id": None,
    # The folder that library watches, kept so the library can be found again
    # if it is removed and added back (it comes back under a new id).
    "output_path": "",
    "builtin_per_request": 1,
    # Fetch finished images over /view when they aren't in the output folder:
    # for a ComfyUI on another machine, whose output folder isn't shared here.
    "download_outputs": True,
    # PEM file to verify an HTTPS ComfyUI with a self-signed certificate.
    "ca_cert": "",
}


def clean_patch(patch: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Drop unknown keys, coerce known ones. Pure."""
    clean: dict[str, Any] = {}
    if "address" in patch:
        clean["address"] = str(patch["address"] or "").strip().rstrip("/")
    if "headers" in patch:
        old = current.get("headers") or {}
        headers: dict[str, str] = {}
        for k, v in (patch["headers"] or {}).items():
            name = str(k).strip()
            if not name:
                continue
            headers[name] = old.get(name, "") if v == MASK else str(v)
        clean["headers"] = headers
    if "builtin_per_request" in patch:
        try:
            clean["builtin_per_request"] = max(
                1, min(64, int(patch["builtin_per_request"]))
            )
        except (TypeError, ValueError):
            pass
    if "download_outputs" in patch:
        clean["download_outputs"] = bool(patch["download_outputs"])
    if "ca_cert" in patch:
        clean["ca_cert"] = str(patch["ca_cert"] or "").strip()
    if "output_path" in patch:
        clean["output_path"] = str(patch["output_path"] or "").strip()
    if "output_library_id" in patch:
        clean["output_library_id"] = patch["output_library_id"] or None
    return clean


def public(s: dict[str, Any]) -> dict[str, Any]:
    return {**s, "headers": {k: MASK for k in (s.get("headers") or {})}}


async def get_settings() -> dict[str, Any]:
    async with async_conn() as conn:
        doc = (
            await conn.execute(
                sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == ROW_ID)
            )
        ).scalar()
    return {**DEFAULT_COMFY_SETTINGS, **(doc or {})}


async def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = await get_settings()
    new_doc = {**current, **clean_patch(patch, current)}
    async with async_tx() as conn:
        stmt = sqlite_insert(t.app_settings).values(_id=ROW_ID, doc=new_doc)
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.app_settings.c._id], set_={"doc": stmt.excluded.doc}
        )
        await conn.execute(stmt)
    return new_doc


async def adopt_output_library(library_id: str, path: str) -> None:
    """Make `library_id` the output library. If the previous one is gone and
    this is its folder coming back, its generated outputs follow: they are
    keyed `{library_id}:{path}`, and a library removed and added back gets a new
    id, which would leave them waiting for a scan that never matches."""
    old = await removed_output_library(path, folder_unknown_ok=True)
    await update_settings({"output_library_id": library_id, "output_path": path})
    if not old:
        return
    async with async_tx() as conn:
        await conn.execute(
            sa.text(
                "UPDATE generation_outputs"
                " SET image_id = :lib || substr(image_id, instr(image_id, ':'))"
                " WHERE substr(image_id, 1, instr(image_id, ':') - 1) = :old"
            ),
            {"lib": library_id, "old": old},
        )


def same_path(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(
        os.path.normpath(b)
    )


async def removed_output_library(
    path: str, *, folder_unknown_ok: bool = False
) -> str | None:
    """The id of the output library when it has been removed and `path` is its
    folder, else None. A folder not remembered (set before it was kept) counts
    as a match only with `folder_unknown_ok`, for the user pointing the
    output folder somewhere themselves."""
    s = await get_settings()
    lib_id, kept = s.get("output_library_id"), s.get("output_path")
    if not lib_id:
        return None
    if kept:
        if not same_path(kept, path):
            return None
    elif not folder_unknown_ok:
        return None
    async with async_conn() as conn:
        found = (
            await conn.execute(
                sa.select(t.libraries.c._id).where(t.libraries.c._id == lib_id)
            )
        ).first()
    return None if found else lib_id
