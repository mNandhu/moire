"""Where a request's outputs land: the library file a local ComfyUI wrote,
or a download into the output library for one on another machine."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path, PurePath
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import comfy_settings, library_nesting
from .comfy_client import ComfyClient, ComfyError, ComfyUnreachable

log = logging.getLogger("moire.generate")


def _write_atomic(dest: Path, data: bytes) -> None:
    # Dot-prefixed staging name: the library watcher ignores it until the rename.
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.part")
    tmp.write_bytes(data)
    os.replace(tmp, dest)


def output_image_id(library_id: str, subfolder: str, filename: str) -> str:
    """The `_id` the scanner gives the file once it lands in the output
    library (`{library_id}:{relative path}`, platform separators)."""
    rel = PurePath(subfolder, filename) if subfolder else PurePath(filename)
    return f"{library_id}:{rel}"


Libraries = list[tuple[str, str]]  # (id, folder)

# How fresh a library file must be to be a just-finished output: an older
# one with the same name is another run's.
OUTPUT_FRESH_S = 600.0


def held_by(libraries: Libraries, path: str) -> str | None:
    """The `_id` the file at ``path`` has in the innermost library holding
    it (the one whose scan owns it), or None when no library does."""
    owner = library_nesting.innermost(path, libraries)
    if owner is None:
        return None
    lib_id, root = owner
    return f"{lib_id}:{os.path.relpath(os.path.normpath(path), os.path.normpath(root))}"


def root_candidates(
    libraries: Libraries, subfolder: str, filename: str, since: float = 0.0
) -> list[str]:
    """Where ComfyUI's output folder may be, from the libraries holding a
    file at ``subfolder/filename`` below it, written since ``since``: a
    library at ``out/Unorganized10`` with ``img.png`` in it says ``out``, for
    ``Unorganized10/img.png``."""
    parts = PurePath(subfolder).parts if subfolder else ()
    found: list[str] = []
    for _, root in libraries:
        rp = Path(root)
        for k in range(len(parts) + 1):
            if k and (
                len(rp.parts) <= k
                or [os.path.normcase(x) for x in rp.parts[-k:]]
                != [os.path.normcase(x) for x in parts[:k]]
            ):
                continue
            try:
                st = rp.joinpath(*parts[k:], filename).stat()
            except OSError:
                continue
            base = str(rp.parents[k - 1] if k else rp)
            if st.st_mtime >= since and base not in found:
                found.append(base)
    return found


async def place_outputs(
    client: ComfyClient | None, files: list[tuple[str, str]], s: dict[str, Any]
) -> tuple[list[str], list[tuple[str, str]]]:
    """Each output's image id, and the outputs to download. Where this
    machine sees ComfyUI's output folder (``output_root``: set, or found
    from an output a library holds), an output is that file, in the
    watched library holding it. Otherwise it is downloaded into the
    output library, as for a ComfyUI on another machine."""
    lib = s.get("output_library_id") or ""
    if not files:
        return [], []
    # Only a watched library picks a new file up by itself.
    async with async_conn() as conn:
        libraries = [
            (r._id, r.path)
            for r in await conn.execute(
                sa.select(t.libraries.c._id, t.libraries.c.path).where(
                    t.libraries.c.watch_enabled.is_(True)
                )
            )
            if r.path
        ]

    def reachable(root: str, sub: str, name: str) -> bool:
        return os.path.isfile(os.path.join(root, sub, name))

    root = s.get("output_root") or ""
    if not root or not any(
        [await asyncio.to_thread(reachable, root, *f) for f in files]
    ):
        for sub, name in files:
            found = await find_output_root(client, libraries, sub, name, s)
            if found:
                root = found
                break
    ids: list[str] = []
    fetch: list[tuple[str, str]] = []
    for sub, name in files:
        here = root and await asyncio.to_thread(reachable, root, sub, name)
        owned = held_by(libraries, os.path.join(root, sub, name)) if here else None
        if owned:
            ids.append(owned)
        else:
            ids.append(output_image_id(lib, sub, name))
            fetch.append((sub, name))
    return ids, fetch


async def find_output_root(
    client: ComfyClient | None,
    libraries: Libraries,
    subfolder: str,
    filename: str,
    s: dict[str, Any],
) -> str | None:
    """ComfyUI's output folder as this machine sees it: a just-written
    library file at ``subfolder/filename`` with the same bytes as
    ComfyUI's output. Remembered in the settings, unless ComfyUI's
    address changed meanwhile."""
    candidates = await asyncio.to_thread(
        root_candidates,
        libraries,
        subfolder,
        filename,
        time.time() - OUTPUT_FRESH_S,
    )
    if not candidates or client is None:
        return None
    try:
        data = await client.view(subfolder, filename)
    except (ComfyUnreachable, ComfyError):
        return None
    for root in candidates:
        try:
            same = (
                await asyncio.to_thread(Path(root, subfolder, filename).read_bytes)
                == data
            )
        except OSError:
            continue
        if not same:
            continue
        now = await comfy_settings.get_settings()
        if now.get("address") != s.get("address"):
            return None
        await comfy_settings.update_settings({"output_root": root})
        log.info("ComfyUI's output folder is %s", root)
        return root
    return None


async def fetch_missing(
    client: ComfyClient | None, library_id: str, files: list[tuple[str, str]]
) -> None:
    """Download outputs this machine can't see (ComfyUI on another host)
    into the output library, where the watcher picks them up. A local
    ComfyUI already wrote them there, so nothing is fetched."""
    assert client is not None
    async with async_conn() as conn:
        root = (
            await conn.execute(
                sa.select(t.libraries.c.path).where(t.libraries.c._id == library_id)
            )
        ).scalar()
    if not root:
        return
    base = Path(root).resolve()
    for sub, name in files:
        dest = (base / sub / name).resolve()
        if not dest.is_relative_to(base) or dest.exists():
            continue
        try:
            data = await client.view(sub, name)
        except (ComfyUnreachable, ComfyError) as e:
            log.warning("Could not fetch %s/%s from ComfyUI: %s", sub, name, e)
            continue
        await asyncio.to_thread(_write_atomic, dest, data)
