"""The app's startup and shutdown sequence, run by the lifespan in main.py."""

from __future__ import annotations

import logging

import anyio  # type: ignore[import-not-found]
import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn, ensure_schema
from .library import nesting as library_nesting, watch as library_watch
from .tags import (
    sensitivity_filter,
    index as tag_index,
    migrations as tag_migrations,
    sensitivity as tag_sensitivity,
)
from .ai.jobs import get_ai_job_manager
from .ai.settings import get_ai_settings
from .ai.tagger import get_tagger_manager
from .ai.face_worker import get_face_worker
from .generate.jobs import get_generation_manager
from .library.storage_fs import ensure_thumb_root

logger = logging.getLogger("moire")


async def start() -> None:
    # Create the SQLite schema (tables + indexes) if absent, and add any
    # column declared since the database was made (with its default).
    await ensure_schema()
    # This library's tag levels, before anything writes tags (the
    # migrations' reprojection included): every write sets ``tag_level``.
    await anyio.to_thread.run_sync(tag_sensitivity.load_overrides_sync)  # type: ignore[attr-defined]
    # The sensitivity filter's maximum, which every visibility clause reads.
    await anyio.to_thread.run_sync(sensitivity_filter.load_sync)  # type: ignore[attr-defined]
    # One-off data migrations (services/tags/migrations.py), before the AI
    # worker and the watchers can write tags in the new spelling alongside old.
    await anyio.to_thread.run_sync(tag_migrations.run_pending)  # type: ignore[attr-defined]
    # Images an outer library indexed from a library inside it belong to the
    # inner one; fold them in (a no-op without nested libraries).
    try:
        await anyio.to_thread.run_sync(library_nesting.adopt_nested_copies)  # type: ignore[attr-defined]
    except Exception:
        logger.exception("Failed to fold nested library copies during startup")
    # Recompute stored tag levels when the shipped list or this library's
    # levels changed since they were computed (first run: all of them).
    await anyio.to_thread.run_sync(tag_sensitivity.sync_levels)  # type: ignore[attr-defined]
    # Ensure the thumbnail root dir exists (run off the event loop)
    await anyio.to_thread.run_sync(ensure_thumb_root)  # type: ignore[attr-defined]
    await _start_ai()
    await _start_watchers()
    # ComfyUI generation: reconnects and reconciles unfinished requests in the
    # background, so a ComfyUI that is down never delays startup.
    get_generation_manager().start()


async def _start_ai() -> None:
    # Start internal AI job worker; with auto-tag on, it picks up what was
    # left untagged when the process last stopped.
    get_ai_job_manager().start()
    get_ai_job_manager().nudge()
    idle_unload_s = None
    try:
        s = await get_ai_settings()
        idle_unload_s = int(s.get("idle_unload_s", 0) or 0)
    except Exception:
        # Best-effort; AI can still run with defaults, but log failures for operators.
        logger.exception("Failed to load AI settings during startup; continuing")
    # The tagger owns its idle-unload loop (started here, stopped on shutdown).
    get_tagger_manager().start(idle_unload_s)
    # Crop every avatar to its face (in the background; a no-op until the
    # face model is switched on and downloaded).
    get_face_worker().start_avatars()


async def _start_watchers() -> None:
    # Start a filesystem watcher for every library that wants one. A library
    # added while the process is down only starts watching on the next boot.
    try:
        async with async_conn() as conn:
            rows = (
                await conn.execute(
                    sa.select(
                        t.libraries.c._id,
                        t.libraries.c.path,
                        t.libraries.c.watch_enabled,
                    )
                )
            ).fetchall()
        for r in rows:
            if r.watch_enabled:
                library_watch.start_watch(r._id, r.path)
    except Exception:
        logger.exception("Failed to start library watchers during startup")


async def stop() -> None:
    # Joins each watcher thread and waits on the watcher process: off the loop.
    await anyio.to_thread.run_sync(library_watch.stop_all)  # type: ignore[attr-defined]
    await get_generation_manager().stop()
    await get_ai_job_manager().stop()
    await get_tagger_manager().stop()
    # Tag view builds a request left running in the background.
    await tag_index.cancel_builds()
