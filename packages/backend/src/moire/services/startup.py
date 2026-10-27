"""The app's startup and shutdown sequence, run by the lifespan in main.py."""

from __future__ import annotations

import logging

import anyio  # type: ignore[import-not-found]
import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn, ensure_schema
from . import library_nesting, library_watch, tag_migrations
from .ai_jobs import get_ai_job_manager
from .ai_settings import get_ai_settings
from .ai_tagger import get_tagger_manager
from .generation_jobs import get_generation_manager
from .storage_fs import ensure_thumb_root

logger = logging.getLogger("moire")


async def start() -> None:
    # Create the SQLite schema (tables + indexes) if absent. Declarative
    # DDL means no flag backfill is needed; columns carry their defaults.
    await ensure_schema()
    # One-off data migrations (services/tag_migrations.py), before the AI
    # worker and the watchers can write tags in the new spelling alongside old.
    await anyio.to_thread.run_sync(tag_migrations.run_pending)  # type: ignore[attr-defined]
    # Images an outer library indexed from a library inside it belong to the
    # inner one; fold them in (a no-op without nested libraries).
    try:
        await anyio.to_thread.run_sync(library_nesting.adopt_nested_copies)  # type: ignore[attr-defined]
    except Exception:
        logger.exception("Failed to fold nested library copies during startup")
    # Ensure the thumbnail root dir exists (run off the event loop)
    await anyio.to_thread.run_sync(ensure_thumb_root)  # type: ignore[attr-defined]
    await _start_ai()
    await _start_watchers()
    # ComfyUI generation: reconnects and reconciles unfinished requests in the
    # background, so a ComfyUI that is down never delays startup.
    get_generation_manager().start()


async def _start_ai() -> None:
    # Start internal AI job worker
    get_ai_job_manager().start()
    idle_unload_s = None
    try:
        s = await get_ai_settings()
        idle_unload_s = int(s.get("idle_unload_s", 0) or 0)
    except Exception:
        # Best-effort; AI can still run with defaults, but log failures for operators.
        logger.exception("Failed to load AI settings during startup; continuing")
    # The tagger owns its idle-unload loop (started here, stopped on shutdown).
    get_tagger_manager().start(idle_unload_s)


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
