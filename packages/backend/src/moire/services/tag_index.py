"""Tag index: the single owner of the cache behind the aggregated tag views.

The Tags browser reads derived views over the ``image_tags`` join table (the
tag lists and the Tags page rows in :mod:`services.tag_browse`, the mosaic
samples in :mod:`services.tag_covers`, the character list and the attire and
facet maps). All are expensive, so all are memoized here. **Invalidation
belongs to this module, not to its callers.** Tag-state writers dirty the
index through :func:`invalidate` once their transaction has committed; see
:mod:`services.image_tags` (which owns every async tag write) and
:func:`services.reproject._flush_batch` (which owns its own sync transaction
and so invalidates per batch). Routers never reach for the cache.

This module imports nothing else from the app, so every writer can import it.

Staleness rule
--------------
A cached entry is valid only if it is within its TTL *and* was computed in the
current generation. :func:`invalidate` bumps the generation, which also means a
read that started before a write cannot store its now-stale result afterwards:
the reader captures the generation before touching the database and discards its
result on store if that generation has moved. Without that discard, a write
landing mid-query would leave stale data cached for a full TTL.

Bulk background writes
----------------------
A bulk AI job writes an image every fraction of a second, and building the
tag list takes seconds, so with a hard :func:`invalidate` per image no view
would ever be cached while a job runs (each build is discarded on store and
every page load rebuilds). Such writers call :func:`invalidate_soft` instead: it
does not bump the generation, so a build that spans it is still stored, and a
cached view stays readable for up to ``_SOFT_STALE_SECONDS`` past a soft write.
The writer owns ending it: a hard :func:`invalidate` when the bulk run ends.

Serving stale, building once
----------------------------
Views read through :func:`cached` go further. A view that soft writes have
made stale (past the window, no hard write since) is still served at once,
and one background build replaces it: a page open during a job answers from
memory instead of waiting seconds per view. Past ``_STALE_MAX_SECONDS`` it is
rebuilt before answering, like a miss. Concurrent misses of one view share a
single build, keyed by generation, so a request that follows a hard write never
joins a build that began before it. An entry's age counts from when its build
began reading, so a build that spans soft writes is not taken as newer than
the data it read; and a build made from other cached views (served stale, or
read with :func:`peek`) is no newer than the oldest of them, so lag never
stacks past the window. A view whose build failed is served stale for
``_RETRY_AFTER_FAILURE_SECONDS`` before it is tried again.

The generation lock is a plain ``threading.Lock`` rather than an ``asyncio``
one: reprojection invalidates from scanner threads, and every critical section
here is a dict operation with no await inside it.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

log = logging.getLogger(__name__)
T = TypeVar("T")

_TAGS_TTL_SECONDS = 30.0
_SAMPLES_TTL_SECONDS = 60.0
# How stale a view may get behind soft writes (a bulk job), see the docstring.
_SOFT_STALE_SECONDS = 15.0
# How old a soft-stale view may be and still be served while it rebuilds.
_STALE_MAX_SECONDS = 120.0

_LOCK = threading.Lock()
_generation = 0
# When the last soft write committed (0: none since start).
_last_soft_write = 0.0
# Each entry is (read_at, generation, value): read_at is when its build began
# reading, or the oldest read_at of the cached views it was made from.
_tags_cache: dict[str, tuple[float, int, list[dict]]] = {}
_samples_cache: dict[tuple[str, int], tuple[float, int, list[dict]]] = {}
# Values derived from every tag (the attire and facet maps): no TTL, only the
# generation, since they are costly to build and change only with a write.
_derived_cache: dict[str, tuple[float, int, Any]] = {}


def invalidate() -> None:
    """Mark every cached view stale. Safe to call from sync threads and from the
    event loop. Callers invalidate *after* their transaction commits, so a
    concurrent reader can never repopulate from uncommitted state."""
    global _generation
    with _LOCK:
        _generation += 1
        _tags_cache.clear()
        _samples_cache.clear()
        _derived_cache.clear()


def invalidate_soft() -> None:
    """A tag write from a bulk background run: cached views may lag it by up to
    ``_SOFT_STALE_SECONDS``. The run must end with :func:`invalidate`."""
    global _last_soft_write
    with _LOCK:
        _last_soft_write = time.time()


def _fresh(stored_at: float, gen: int, now: float) -> bool:
    """Not superseded: same generation, and no soft write since it was stored
    unless it is still inside the soft staleness window. Caller holds _LOCK."""
    if gen != _generation:
        return False
    return _last_soft_write <= stored_at or (now - stored_at) < _SOFT_STALE_SECONDS


def current_generation() -> int:
    with _LOCK:
        return _generation


_CACHES: dict[str, dict] = {
    "views": _tags_cache,
    "samples": _samples_cache,
    "derived": _derived_cache,
}
_TTLS: dict[str, float | None] = {
    "views": _TAGS_TTL_SECONDS,
    "samples": _SAMPLES_TTL_SECONDS,
    "derived": None,
}
# How long a view whose build failed is served stale before another build is
# tried, so a busy database isn't asked again on every request.
_RETRY_AFTER_FAILURE_SECONDS = 10.0

# Builds under way, by (cache, key, generation). Touched only on the event loop.
_inflight: dict[tuple[str, Any, int], asyncio.Task] = {}
# Builds someone awaits: their failure reaches that caller, so isn't logged.
_awaited: set[asyncio.Task] = set()
# When the last build of (cache, key) failed.
_failed_at: dict[tuple[str, Any], float] = {}
# Inside a build: the read_at of every cached input it took, so its own entry
# is no newer than the oldest of them (a soft-stale input makes it stale too).
_inputs: contextvars.ContextVar[list[float] | None] = contextvars.ContextVar(
    "tag_index_inputs", default=None
)


def _lookup(
    name: str, key: Any, valid: Callable[[Any], bool] | None
) -> tuple[str, Any, float]:
    """("fresh" | "stale" | "miss", value, read_at). Stale: only soft writes
    have passed it, and it is young enough to serve while it rebuilds."""
    now = time.time()
    ttl = _TTLS[name]
    with _LOCK:
        entry = _CACHES[name].get(key)
        if entry is None:
            return "miss", None, 0.0
        read_at, gen, value = entry
        if gen != _generation or (valid is not None and not valid(value)):
            return "miss", None, 0.0
        age = now - read_at
        if _fresh(read_at, gen, now) and (ttl is None or age < ttl):
            return "fresh", value, read_at
        if _last_soft_write > read_at and age < _STALE_MAX_SECONDS:
            return "stale", value, read_at
        return "miss", None, 0.0


def _note_input(read_at: float) -> None:
    inputs = _inputs.get()
    if inputs is not None:
        inputs.append(read_at)


def _build(
    name: str,
    key: Any,
    build: Callable[[], Awaitable[T]],
    gen: int | None,
    *,
    replace: bool = False,
) -> asyncio.Task:
    """The build of ``key`` for generation ``gen`` (default: the current one):
    the one under way, or a new one (``replace``: always new), which stores
    its result unless a hard write lands meanwhile."""
    if gen is None:
        with _LOCK:
            gen = _generation
    slot = (name, key, gen)
    task = _inflight.get(slot)
    if (
        not replace
        and task is not None
        and task.get_loop() is asyncio.get_running_loop()
    ):
        return task

    async def run() -> tuple[float, T]:
        # Its own list (the task copied the caller's context, and with it any
        # list of the build that started this one).
        inputs = [time.time()]
        _inputs.set(inputs)
        value = await build()
        with _LOCK:
            if gen == _generation:
                _CACHES[name][key] = (min(inputs), gen, value)
        return min(inputs), value

    task = asyncio.get_running_loop().create_task(run())
    _inflight[slot] = task

    def done(t: asyncio.Task) -> None:
        if _inflight.get(slot) is t:
            del _inflight[slot]
        awaited = t in _awaited
        _awaited.discard(t)
        if t.cancelled():
            return
        # Retrieved here either way, so a build nobody awaited is logged, not
        # left to "exception was never retrieved".
        exc = t.exception()
        if exc is None:
            _failed_at.pop((name, key), None)
            return
        _failed_at[(name, key)] = time.time()
        if not awaited:
            log.warning("tag view build %s failed", key, exc_info=exc)

    task.add_done_callback(done)
    return task


async def _await(task: asyncio.Task) -> Any:
    _awaited.add(task)
    # Shielded: a request that goes away doesn't cancel a build others share.
    read_at, value = await asyncio.shield(task)
    _note_input(read_at)
    return value


async def cached(
    name: str,
    key: Any,
    build: Callable[[], Awaitable[T]],
    *,
    valid: Callable[[T], bool] | None = None,
    stale: bool = True,
    gen: int | None = None,
) -> T:
    """``key`` from the ``name`` cache ("views", "samples" or "derived"),
    built with ``build`` when missing. Stale-while-revalidate behind soft
    writes, one build per key at a time; see the module docstring.

    ``valid`` rejects a value built from inputs that have since changed (a new
    tagger vocabulary). ``stale=False``: a soft-stale value is rebuilt before
    answering, for a count a poll follows. ``gen``: the generation the build's
    inputs were read in, when the caller read some before calling (it is not
    stored if a hard write came since). The caller must not mutate the value.

    Called inside another build, a cached input it takes ages the outer
    entry: a build is never fresher than what it was made from."""
    state, value, read_at = _lookup(name, key, valid)
    if state == "fresh":
        _note_input(read_at)
        return value
    if state == "stale" and stale:
        failed = _failed_at.get((name, key))
        if failed is None or time.time() - failed >= _RETRY_AFTER_FAILURE_SECONDS:
            _build(name, key, build, gen)
        _note_input(read_at)
        return value
    value = await _await(_build(name, key, build, gen))
    if valid is not None and not valid(value):
        # Joined a build begun from older inputs (before a vocabulary reload).
        value = await _await(_build(name, key, build, gen, replace=True))
    return value


def peek(name: str, key: Any) -> Any:
    """``key``'s cached value if one may be served (fresh or soft-stale), else
    ``None``. Never builds: for a reader that can do with less without it."""
    state, value, read_at = _lookup(name, key, None)
    if state == "miss":
        return None
    _note_input(read_at)
    return value


async def cancel_builds() -> None:
    """Stop the builds under way (shutdown: before the database closes)."""
    loop = asyncio.get_running_loop()
    tasks = [t for t in _inflight.values() if t.get_loop() is loop]
    _inflight.clear()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def reset_for_tests() -> None:
    """Drop all cached state and the generation counter."""
    global _generation, _last_soft_write
    with _LOCK:
        _generation = 0
        _last_soft_write = 0.0
        _tags_cache.clear()
        _samples_cache.clear()
        _derived_cache.clear()
        _inflight.clear()
        _awaited.clear()
        _failed_at.clear()
