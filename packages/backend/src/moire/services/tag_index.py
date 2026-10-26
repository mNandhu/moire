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

The generation lock is a plain ``threading.Lock`` rather than an ``asyncio``
one: reprojection invalidates from scanner threads, and every critical section
here is a dict operation with no await inside it.
"""

from __future__ import annotations

import threading
import time
from typing import Any

_TAGS_TTL_SECONDS = 30.0
_SAMPLES_TTL_SECONDS = 60.0

_LOCK = threading.Lock()
_generation = 0
# Each entry is (stored_at, generation, value).
_tags_cache: dict[str, tuple[float, int, list[dict]]] = {}
_samples_cache: dict[tuple[str, int], tuple[float, int, list[dict]]] = {}
# Values derived from every tag (the attire and facet maps): no TTL, only the
# generation, since they are costly to build and change only with a write.
_derived_cache: dict[str, tuple[int, Any]] = {}


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


def current_generation() -> int:
    with _LOCK:
        return _generation


def _read(
    cache: dict[Any, tuple[float, int, list[dict]]], key: Any, ttl: float
) -> list[dict] | None:
    now = time.time()
    with _LOCK:
        entry = cache.get(key)
        if entry is None:
            return None
        stored_at, gen, value = entry
        if gen != _generation or (now - stored_at) >= ttl:
            return None
        return value


def _store(
    cache: dict[Any, tuple[float, int, list[dict]]],
    key: Any,
    gen: int,
    value: list[dict],
) -> None:
    """Store only if no write intervened since ``gen`` was captured."""
    with _LOCK:
        if gen != _generation:
            return
        cache[key] = (time.time(), gen, value)


def read_view(key: str) -> list[dict] | None:
    """A cached tag view (the tag lists, the Tags page rows, the character
    list: one TTL, one invalidation), or None when stale."""
    return _read(_tags_cache, key, _TAGS_TTL_SECONDS)


def store_view(key: str, gen: int, value: list[dict]) -> None:
    """Cache ``value`` under ``key`` unless a write intervened since ``gen``
    (:func:`current_generation`, read before building it)."""
    _store(_tags_cache, key, gen, value)


def read_samples(key: tuple[str, int]) -> list[dict] | None:
    """A cached mosaic (``(tag, per)``), on its own longer TTL, or None."""
    return _read(_samples_cache, key, _SAMPLES_TTL_SECONDS)


def store_samples(key: tuple[str, int], gen: int, value: list[dict]) -> None:
    """Cache a mosaic unless a write intervened since ``gen``."""
    _store(_samples_cache, key, gen, value)


def read_derived(key: str) -> Any:
    """A value stored with :func:`store_derived`, ``None`` once a write
    intervened."""
    with _LOCK:
        entry = _derived_cache.get(key)
        return entry[1] if entry is not None and entry[0] == _generation else None


def store_derived(key: str, gen: int, value: Any) -> None:
    """Keep ``value`` until the next write, unless one already happened since
    ``gen`` was captured."""
    with _LOCK:
        if gen == _generation:
            _derived_cache[key] = (gen, value)


def reset_for_tests() -> None:
    """Drop all cached state and the generation counter."""
    global _generation
    with _LOCK:
        _generation = 0
        _tags_cache.clear()
        _samples_cache.clear()
        _derived_cache.clear()
