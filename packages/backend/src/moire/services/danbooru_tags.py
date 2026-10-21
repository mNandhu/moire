"""Danbooru's tag list: every tag with 20+ posts, its category, post count and
aliases (``blowjob`` is ``fellatio``).

The prompt board uses it to tell a real tag the groups don't list
(``blue_sky``) from a typo, to read an alias as its tag, and to rank
suggestions by how common a tag is (a fair proxy for how well a model knows
it). The library's own tags never go through it.

It is downloaded, not shipped: DraconicDragon's ``dbr-e621-lists-archive``
(Unlicense) republishes Danbooru's list every three months, in the
autocomplete CSV form ``name,category,posts,"alias,alias"``. Moiré fetches
the newest one the first time it is needed and again once it is
:data:`MAX_AGE` old, into the model cache. Without it (offline, a failed
fetch) everything here answers empty and the board still works.

Kept from the aliases: only those naming one tag, that aren't a tag
themselves, and not autocomplete shortcuts (``/lh``).
"""

from __future__ import annotations

import asyncio
import csv
import logging
import os
import re
import time
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import httpx

from ..core.config import settings

logger = logging.getLogger("moire.danbooru_tags")

LISTING_URL = "https://api.github.com/repos/DraconicDragon/dbr-e621-lists-archive/contents/tag-lists/danbooru"
RAW_BASE = "https://raw.githubusercontent.com/DraconicDragon/dbr-e621-lists-archive/main/tag-lists/danbooru/"
# The newest when this was written: the fallback when the listing can't be read.
PINNED = "danbooru_2026-10-01_pt20-ia-dd.csv"
# The full list (all posts counts) is the `pt20` one: tags with 20+ posts.
_LIST_NAME = re.compile(r"^danbooru_(\d{4}-\d{2}-\d{2})_pt20-ia-dd\.csv$")
MAX_AGE = 92 * 24 * 3600
# After a failed fetch, wait this long before trying again.
RETRY_AFTER = 3600

GENERAL, ARTIST, COPYRIGHT, CHARACTER, META = 0, 1, 3, 4, 5


@dataclass(frozen=True)
class TagList:
    """``tag -> (category, posts)`` and ``alias -> tag``, names lowercase."""

    tags: dict[str, tuple[int, int]] = field(default_factory=dict)
    aliases: dict[str, str] = field(default_factory=dict)

    def resolve(self, name: str) -> str:
        """The tag an alias stands for, else the name itself."""
        return self.aliases.get(name, name)


EMPTY = TagList()


def parse(lines) -> TagList:
    """A :class:`TagList` from the CSV's lines. Malformed rows are skipped."""
    tags: dict[str, tuple[int, int]] = {}
    seen: dict[str, str | None] = {}
    for row in csv.reader(lines):
        if len(row) < 3:
            continue
        name = row[0].strip().lower()
        try:
            category, posts = int(row[1]), int(row[2])
        except ValueError:
            continue
        if not name:
            continue
        tags[name] = (category, posts)
        for alias in row[3].split(",") if len(row) > 3 else ():
            a = alias.strip().lower()
            if not a or a.startswith("/"):
                continue
            # Two tags claiming one alias: it names neither.
            seen[a] = None if a in seen and seen[a] != name else name
    aliases = {a: t for a, t in seen.items() if t and a not in tags}
    return TagList(tags, aliases)


def list_path() -> Path:
    return settings.model_cache_dir_path / "danbooru" / "danbooru-tags.csv"


@lru_cache(maxsize=2)
def _read(path: str, mtime: float) -> TagList:
    with open(path, encoding="utf-8", newline="") as f:
        return parse(f)


def _load() -> TagList:
    path = list_path()
    try:
        return _read(str(path), path.stat().st_mtime)
    except (OSError, ValueError):
        return EMPTY


async def load() -> TagList:
    """The downloaded list, read once per file; empty without one. Starts a
    fetch when it is missing or old."""
    ensure_fresh()
    return await asyncio.to_thread(_load)


# -- Download -----------------------------------------------------------------

_task: asyncio.Task | None = None
_failed_at = 0.0


def _stale(path: Path) -> bool:
    try:
        return time.time() - path.stat().st_mtime > MAX_AGE
    except OSError:
        return True


def _has_tags(path: Path) -> bool:
    with open(path, encoding="utf-8", newline="") as f:
        return bool(parse(f).tags)


def ensure_fresh() -> None:
    """Fetch the list in the background when it is missing or old, once at a
    time, and not again for a while after a failure."""
    global _task
    if _task is not None and not _task.done():
        return
    if not _stale(list_path()) or time.time() - _failed_at < RETRY_AFTER:
        return
    _task = asyncio.get_running_loop().create_task(_fetch())


def newest(names: list[str]) -> str | None:
    """The newest full list among a folder listing's file names."""
    dated = [(m.group(1), n) for n in names if (m := _LIST_NAME.match(n))]
    return max(dated)[1] if dated else None


async def _fetch() -> None:
    global _failed_at
    path = list_path()
    tmp = path.with_suffix(".part")
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            name = PINNED
            try:
                r = await client.get(
                    LISTING_URL, headers={"Accept": "application/vnd.github+json"}
                )
                r.raise_for_status()
                name = (
                    newest([e.get("name", "") for e in r.json() if isinstance(e, dict)])
                    or PINNED
                )
            except (httpx.HTTPError, ValueError) as exc:
                logger.info(
                    "Danbooru tag list: listing unavailable (%s); using %s", exc, PINNED
                )
            path.parent.mkdir(parents=True, exist_ok=True)
            async with client.stream("GET", RAW_BASE + name) as resp:
                resp.raise_for_status()
                with open(tmp, "wb") as out:
                    async for chunk in resp.aiter_bytes():
                        out.write(chunk)
        # A list that reads as empty is a bad download, not a new list.
        if not await asyncio.to_thread(_has_tags, tmp):
            raise ValueError("empty tag list")
        os.replace(tmp, path)
        logger.info("Danbooru tag list: fetched %s", name)
    except (httpx.HTTPError, OSError, ValueError) as exc:
        _failed_at = time.time()
        logger.warning("Danbooru tag list: fetch failed: %s", exc)
        tmp.unlink(missing_ok=True)


def reset_for_tests() -> None:
    global _task, _failed_at
    _task, _failed_at = None, 0.0
    _read.cache_clear()
