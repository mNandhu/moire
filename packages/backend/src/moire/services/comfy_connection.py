"""Applying a ComfyUI settings change: the output folder registered as a
watched Library, the certificate and output root checked, the stored row
updated and the generation client reconfigured when the connection moved.
"""

from __future__ import annotations

import os
import ssl
from typing import Any

from ..models.library import LibraryIn
from . import comfy_settings, library_ops
from .generation_jobs import get_generation_manager


class SettingsError(ValueError):
    """A setting can't be used as given (unreadable certificate, missing folder)."""


async def settings_view() -> dict[str, Any]:
    s = await comfy_settings.get_settings()
    out = comfy_settings.public(s)
    out["output_path"] = None
    if s.get("output_library_id"):
        out["output_path"] = await library_ops.path_of(s["output_library_id"])
    return out


async def apply_patch(patch: dict[str, Any]) -> None:
    """Store ``patch`` (``output_path`` becomes ``output_library_id``).
    Raises library_ops.BadPath or SettingsError."""
    patch = dict(patch)
    output_path = patch.pop("output_path", None)
    if output_path is not None:
        if not output_path.strip():
            patch["output_library_id"] = None
        else:
            # Checked and normalized as the Add Library form's path is.
            try:
                lib = LibraryIn(path=output_path, name="ComfyUI output")
            except ValueError as e:
                raise SettingsError(str(e)) from e
            # Outputs reach the library through its watcher, so a reused
            # library with watching off gets it turned on.
            patch["output_library_id"] = await library_ops.ensure_watched(
                lib.path, "ComfyUI output"
            )
    if patch.get("ca_cert"):
        try:
            ssl.create_default_context(cafile=patch["ca_cert"].strip())
        except (OSError, ssl.SSLError) as e:
            raise SettingsError(f"Can't read the certificate: {e}") from e
    if patch.get("output_root") and not os.path.isdir(patch["output_root"].strip()):
        raise SettingsError("That folder doesn't exist")
    before = await comfy_settings.get_settings()
    after = await comfy_settings.update_settings(patch)
    # Another ComfyUI saves somewhere else: find its folder again.
    if "output_root" not in patch and before.get("address") != after.get("address"):
        after = await comfy_settings.update_settings({"output_root": ""})
    if any(before.get(k) != after.get(k) for k in ("address", "headers", "ca_cert")):
        await get_generation_manager().configure()
