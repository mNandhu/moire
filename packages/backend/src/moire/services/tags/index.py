"""Tag index: the single owner of the cache behind the aggregated tag views.

The Tags browser reads derived views over the ``image_tags`` join table (the
tag lists and the Tags page rows in :mod:`services.tags.browse`, the mosaic
samples in :mod:`services.tags.covers`, the character list and the attire and
facet maps). All are expensive, so all are memoized here. **Invalidation
belongs to this module, not to its callers.** Tag-state writers dirty the
index through :func:`invalidate` once their transaction has committed; see
:mod:`services.tags.image_tags` (which owns every async tag write) and
:func:`services.metadata.reproject._flush_batch` (which owns its own sync transaction
and so soft-invalidates per batch, its run invalidating once at the end, see
below). Routers never reach for the cache.

This module imports nothing else from the app, so every writer can import it.

Staleness rule
--------------
A cached entry is valid only if it is within its TTL *and* was computed in the
current generation. Every :func:`invalidate` bumps the generation; a strict one
also raises the floor (``_floor``) to it. An entry, or a build, whose
generation is below the floor read before a strict write: it is never served
and never stored, whether or not the dicts were cleared. The reader captures
the generation before touching the database and discards its result on store
if a strict write came since. Without that discard, a write landing mid-query
would leave stale data cached for a full TTL. Two kinds of write relax this,
each below: a soft write (its window may outlast the TTL), and a refresh
invalidate (an entry at or above the floor but below the current generation
read before a refresh, and is served stale while it rebuilds).

Bulk background writes
----------------------
A bulk AI job writes an image every fraction of a second, and building the
tag list takes seconds, so with a hard :func:`invalidate` per image no view
would ever be cached while a job runs (each build is discarded on store and
every page load rebuilds). A reprojection run's batches are the same. Such
writers call :func:`invalidate_soft` instead: it
does not bump the generation, so a build that spans it is still stored, and a
cached view stays fresh for a while past a soft write: its soft window. Each
window's end costs a rebuild of every view in use, so the window scales with
what the view's last build took (``_soft_window``): ten builds' time, at
least ``_SOFT_STALE_SECONDS`` (15 s, what a cheap view gets) and at most 60 s.
A view that takes 4 s to build is rebuilt about every 40 s of a job instead of
every 15 s. While soft writes run, the window stands in for the TTL (it may
outlast it). The writer owns ending it with an :func:`invalidate` when the
bulk run ends: a refresh one for an AI job, a strict one for a reprojection.

Refreshing after a write
------------------------
A plain :func:`invalidate` is strict: every cached view is dropped, and the
next reader of each waits for a fresh build (seconds for the Tags page on a
big library). That is right where the user expects to see their own edit at
once, and required where a key does not name everything its value depends
on: the ``/tags`` lists and ``browse:{source}`` leave out the tags the
sensitivity filter hides without the filter in their key, so a filter change
served stale would show hidden tags until the rebuild ended.

A write the views may trail for one build opts in with
``invalidate(refresh=True)``: an AI job's end (its views lagged the whole run
anyway) and one image's AI tagging (the image view reads the image's own
tags, not these views). It bumps the generation but not the floor, and keeps
the entries: :func:`cached` serves each as stale while one background build
replaces it, if it was servable when the refresh came (within its TTL, or
behind soft writes) and is younger than ``_STALE_MAX_SECONDS``; one already
past its TTL is a miss, as it would have been without the refresh.

A build begun before a refresh still stores its result, under its own (older)
generation: it is served stale and rebuilt once, so refreshes that come
faster than a slow view builds still leave a view to serve, and each key has
one build under way at a time. A reader that misses may join that build and
get its result, which is no fresher than stale; ``cached(stale=False)`` never
does, it waits for a build begun after the last refresh. An entry that read
before the last refresh is never fresh again, and a view built from one (a
stale input, see below) takes its generation, so it is rebuilt in turn. A
later strict :func:`invalidate` drops them all, as ever.

A refresh is strict while the predicate given to :func:`refresh_allowed_when`
says no. The sensitivity filter registers one: while the filter is on, AI
tagging can change an image's level and so whether it shows, and a view
served stale would keep a now-hidden image as a cover or in a count. Kept
here, so no caller can get it wrong.

:func:`peek` does not return before-refresh entries: its reader cannot start
the build that ends the staleness, and would stamp its own result with the old
read for as long as no one opened the view it peeked. It gets ``None`` and
reads the database itself, in a build whose own stale view is served meanwhile.

Serving stale, building once
----------------------------
Views read through :func:`cached` go further. A view that soft writes have
made stale (past the window, no hard write since) is still served at once,
and one background build replaces it: a page open during a job answers from
memory instead of waiting seconds per view. Past ``_STALE_MAX_SECONDS`` it is
rebuilt before answering, like a miss. Concurrent misses of one view share a
single build, and a request that follows a strict write never joins a build
that began before it. An entry's age counts from when its build began
reading, so a build that spans soft writes is not taken as newer than the data
it read; and a build made from other cached views (served stale, or read with
:func:`peek`) is no newer (in read time and generation) than the oldest of
them, so lag never stacks past the window. A view whose build failed is
served stale for ``_RETRY_AFTER_FAILURE_SECONDS`` before it is tried again.

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
# How stale a view may get behind soft writes (a bulk job), see the docstring:
# at least this, and for a view slow to build, _SOFT_WINDOW_BUILDS times its
# build, up to _SOFT_WINDOW_CEILING times this (60 s: half _STALE_MAX_SECONDS,
# so the view is still served stale while the rebuild that follows runs).
_SOFT_STALE_SECONDS = 15.0
_SOFT_WINDOW_BUILDS = 10.0
_SOFT_WINDOW_CEILING = 4.0
# How old a soft-stale view may be and still be served while it rebuilds.
_STALE_MAX_SECONDS = 120.0

_LOCK = threading.Lock()
# Bumped by every invalidate. An entry of an older one (at or above _floor)
# read before a refresh: served stale, never fresh.
_generation = 0
# The generation of the last strict invalidate: nothing older is ever served
# or stored.
_floor = 0
# When the last refresh invalidate came (0: none): a before-refresh entry is
# servable only if it was then (see _lookup).
_refresh_at = 0.0
# Whether a refresh invalidate may be one (else it is strict); see
# refresh_allowed_when. Always, until a predicate is registered.
_refresh_allowed: Callable[[], bool] = lambda: True  # noqa: E731
# When the last soft write committed (0: none since start).
_last_soft_write = 0.0
# Each entry is (read_at, generation, value): read_at and generation are when
# its build began reading, or the oldest of the cached views it was made from.
_tags_cache: dict[str, tuple[float, int, list[dict]]] = {}
_samples_cache: dict[tuple[str, int], tuple[float, int, list[dict]]] = {}
# Values derived from every tag (the attire and facet maps): no TTL, only the
# generation, since they are costly to build and change only with a write.
_derived_cache: dict[str, tuple[float, int, Any]] = {}


def invalidate(*, refresh: bool = False) -> None:
    """Mark every cached view stale. Safe to call from sync threads and from the
    event loop. Callers invalidate *after* their transaction commits, so a
    concurrent reader can never repopulate from uncommitted state.

    ``refresh``: the views may trail this write for one build, so readers get
    the previous ones while they rebuild (see the module docstring). Strict by
    default: opt in only for a write the user does not wait to see, and never
    for one that changes what a view may show (the sensitivity filter). Also
    strict, whatever the caller asked, while the predicate given to
    :func:`refresh_allowed_when` says no (the filter is on)."""
    global _generation, _floor, _refresh_at
    if refresh and not _refresh_allowed():
        refresh = False
    with _LOCK:
        _generation += 1
        if refresh:
            _refresh_at = time.time()
            return
        _floor = _generation
        _tags_cache.clear()
        _samples_cache.clear()
        _derived_cache.clear()
        # Each key's duration is recorded again by the build that stores it,
        # so this keeps it no bigger than the caches.
        _build_seconds.clear()


def refresh_allowed_when(predicate: Callable[[], bool]) -> None:
    """Make ``invalidate(refresh=True)`` strict whenever ``predicate()`` is
    false (asked at each invalidate). The sensitivity filter registers one,
    refresh only while it is off: this module imports nothing from the app,
    so the rule that depends on the filter is handed in."""
    global _refresh_allowed
    _refresh_allowed = predicate


def invalidate_soft() -> None:
    """A tag write from a bulk background run: cached views may lag it by up to
    their soft window (``_soft_window``). The run must end with
    :func:`invalidate`."""
    global _last_soft_write
    with _LOCK:
        _last_soft_write = time.time()


def _soft_window(name: str, key: Any) -> float:
    """How long ``key`` stays fresh behind soft writes: ``_SOFT_WINDOW_BUILDS``
    times its last build's duration, so its rebuilds during a bulk run take
    at most about a tenth of the time, kept between ``_SOFT_STALE_SECONDS``
    and ``_SOFT_WINDOW_CEILING`` times that."""
    took = _build_seconds.get((name, key), 0.0)
    return min(
        max(_SOFT_STALE_SECONDS, _SOFT_WINDOW_BUILDS * took),
        _SOFT_WINDOW_CEILING * _SOFT_STALE_SECONDS,
    )


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

# The build under way of (cache, key): (its generation, task).
# Touched only on the event loop.
_inflight: dict[tuple[str, Any], tuple[int, asyncio.Task]] = {}
# Builds someone awaits: their failure reaches that caller, so isn't logged.
_awaited: set[asyncio.Task] = set()
# When the last build of (cache, key) failed.
_failed_at: dict[tuple[str, Any], float] = {}
# How many seconds the last stored build of (cache, key) took (_soft_window).
# Only a stored build records, and a strict invalidate clears it with the
# caches, so it holds no key they don't.
_build_seconds: dict[tuple[str, Any], float] = {}
# Inside a build: the (read_at, generation) of every cached input it took, so
# its own entry is no newer than the oldest of them (a stale input makes it
# stale too).
_inputs: contextvars.ContextVar[list[tuple[float, int]] | None] = (
    contextvars.ContextVar("tag_index_inputs", default=None)
)


def _lookup(
    name: str,
    key: Any,
    valid: Callable[[Any], bool] | None,
    *,
    refreshed: bool = True,
) -> tuple[str, Any, float, int]:
    """("fresh" | "stale" | "miss", value, read_at, generation). Stale: only
    soft writes and refresh invalidates (``refreshed``: those count) have
    passed it, and it is young enough to serve while it rebuilds."""
    now = time.time()
    ttl = _TTLS[name]
    with _LOCK:
        entry = _CACHES[name].get(key)
        if entry is None:
            return "miss", None, 0.0, 0
        read_at, gen, value = entry
        # Below the floor: read before a strict write, never served.
        if gen < _floor or (valid is not None and not valid(value)):
            return "miss", None, 0.0, 0
        age = now - read_at
        soft = _last_soft_write > read_at
        before_refresh = gen < _generation
        if not before_refresh and (
            age < _soft_window(name, key) if soft else ttl is None or age < ttl
        ):
            return "fresh", value, read_at, gen
        if age >= _STALE_MAX_SECONDS:
            return "miss", None, 0.0, 0
        if before_refresh:
            # Servable stale only if it was when the refresh came: behind
            # soft writes, or within its TTL. One past its TTL by then was
            # already a miss.
            if refreshed and (soft or ttl is None or _refresh_at - read_at < ttl):
                return "stale", value, read_at, gen
            return "miss", None, 0.0, 0
        if soft:
            return "stale", value, read_at, gen
        return "miss", None, 0.0, 0


def _note_input(read_at: float, gen: int) -> None:
    inputs = _inputs.get()
    if inputs is not None:
        inputs.append((read_at, gen))


def _build(
    name: str,
    key: Any,
    build: Callable[[], Awaitable[T]],
    gen: int | None,
    *,
    replace: bool = False,
    fresh: bool = False,
) -> asyncio.Task:
    """The build of ``key`` for generation ``gen`` (default: the current one):
    the one under way, unless a strict write came since it began (``fresh``:
    or a refresh), else a new one (``replace``: always new). It stores its
    result unless a strict write lands meanwhile."""
    slot = (name, key)
    with _LOCK:
        if gen is None:
            gen = _generation
        floor, current = _floor, _generation
    running = _inflight.get(slot)
    if not replace and running is not None:
        run_gen, task = running
        if (
            task.get_loop() is asyncio.get_running_loop()
            and run_gen >= floor
            and (not fresh or run_gen == current)
        ):
            return task

    async def run() -> tuple[float, int, T]:
        # Its own list (the task copied the caller's context, and with it any
        # list of the build that started this one).
        inputs = [(time.time(), gen)]
        _inputs.set(inputs)
        began = time.monotonic()
        value = await build()
        took = time.monotonic() - began
        read_at = min(r for r, _ in inputs)
        read_gen = min(g for _, g in inputs)
        with _LOCK:
            held = _CACHES[name].get(key)
            # Not across a strict write, and never over a newer read (a
            # replacement build that finished first).
            if gen >= _floor and (
                held is None or (held[1], held[0]) <= (read_gen, read_at)
            ):
                _CACHES[name][key] = (read_at, read_gen, value)
                _build_seconds[(name, key)] = took
        return read_at, read_gen, value

    task = asyncio.get_running_loop().create_task(run())
    _inflight[slot] = (gen, task)

    def done(t: asyncio.Task) -> None:
        held = _inflight.get(slot)
        if held is not None and held[1] is t:
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
    read_at, gen, value = await asyncio.shield(task)
    _note_input(read_at, gen)
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
    writes and refresh invalidates, one build per key at a time; see the
    module docstring.

    ``valid`` rejects a value built from inputs that have since changed (a new
    tagger vocabulary). ``stale=False``: a soft-stale value is rebuilt before
    answering, for a count a poll follows. ``gen``: the generation the build's
    inputs were read in, when the caller read some before calling (it is not
    stored if a hard write came since). The caller must not mutate the value.

    Called inside another build, a cached input it takes ages the outer
    entry: a build is never fresher than what it was made from."""
    state, value, read_at, read_gen = _lookup(name, key, valid)
    if state == "fresh":
        _note_input(read_at, read_gen)
        return value
    if state == "stale" and stale:
        failed = _failed_at.get((name, key))
        if failed is None or time.time() - failed >= _RETRY_AFTER_FAILURE_SECONDS:
            _build(name, key, build, gen)
        _note_input(read_at, read_gen)
        return value
    value = await _await(_build(name, key, build, gen, fresh=not stale))
    if valid is not None and not valid(value):
        # Joined a build begun from older inputs (before a vocabulary reload).
        value = await _await(_build(name, key, build, gen, replace=True))
    return value


def peek(name: str, key: Any) -> Any:
    """``key``'s cached value if one may be served (fresh or soft-stale), else
    ``None``. Never builds: for a reader that can do with less without it.
    Never one a refresh invalidate left (see the module docstring)."""
    state, value, read_at, read_gen = _lookup(name, key, None, refreshed=False)
    if state == "miss":
        return None
    _note_input(read_at, read_gen)
    return value


async def cancel_builds() -> None:
    """Stop the builds under way (shutdown: before the database closes)."""
    loop = asyncio.get_running_loop()
    tasks = [t for _, t in _inflight.values() if t.get_loop() is loop]
    _inflight.clear()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def reset_for_tests() -> None:
    """Drop all cached state and the generation counter (not the predicate
    given to :func:`refresh_allowed_when`: its module registers it once)."""
    global _generation, _floor, _refresh_at, _last_soft_write
    with _LOCK:
        _generation = 0
        _floor = 0
        _refresh_at = 0.0
        _last_soft_write = 0.0
        _tags_cache.clear()
        _samples_cache.clear()
        _derived_cache.clear()
        _inflight.clear()
        _awaited.clear()
        _failed_at.clear()
        _build_seconds.clear()
