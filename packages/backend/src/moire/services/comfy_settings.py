"""The "comfyui" settings row: address, optional headers, output library,
built-in images per request. Headers stay server-side; the API returns their
names with masked values, and a masked value on update keeps the stored one.
"""

from __future__ import annotations

from typing import Any

from . import app_settings
from .generation_limits import clamp_per_request


ROW_ID = "comfyui"
MASK = "••••"

DEFAULT_COMFY_SETTINGS: dict[str, Any] = {
    "address": "",
    "headers": {},
    "output_library_id": None,
    "builtin_per_request": 1,
    # Fetch finished images over /view when they aren't in the output folder:
    # for a ComfyUI on another machine, whose output folder isn't shared here.
    "download_outputs": True,
    # ComfyUI's own output folder as this machine sees it, when it does
    # (found from the first output a library holds): outputs there are
    # linked where they are instead of downloaded. "" until known.
    "output_root": "",
    # PEM file to verify an HTTPS ComfyUI with a self-signed certificate.
    "ca_cert": "",
    # What a character picked in Generate starts wearing: "none" (identity
    # only) or "default" (their usual attire tags).
    "new_character_outfit": "none",
}

OUTFIT_STARTS = ("none", "default")


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
            clean["builtin_per_request"] = clamp_per_request(
                int(patch["builtin_per_request"])
            )
        except (TypeError, ValueError):
            pass
    if "download_outputs" in patch:
        clean["download_outputs"] = bool(patch["download_outputs"])
    if "output_root" in patch:
        clean["output_root"] = str(patch["output_root"] or "").strip()
    if "ca_cert" in patch:
        clean["ca_cert"] = str(patch["ca_cert"] or "").strip()
    if patch.get("new_character_outfit") in OUTFIT_STARTS:
        clean["new_character_outfit"] = patch["new_character_outfit"]
    if "output_library_id" in patch:
        clean["output_library_id"] = patch["output_library_id"] or None
    return clean


def public(s: dict[str, Any]) -> dict[str, Any]:
    return {**s, "headers": {k: MASK for k in (s.get("headers") or {})}}


async def get_settings() -> dict[str, Any]:
    doc = await app_settings.read(ROW_ID)
    return {**DEFAULT_COMFY_SETTINGS, **(doc or {})}


async def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = await get_settings()
    new_doc = {**current, **clean_patch(patch, current)}
    await app_settings.write(ROW_ID, new_doc)
    return new_doc
