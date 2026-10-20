"""Libraries inside other libraries.

A folder belongs to the innermost library holding it. The outer library's
scan and watcher leave a nested library's folder alone, and the rows an outer
library wrote for those files before (an older scan, or a library added
inside it later) are folded into the inner library's rows by
:func:`adopt_nested_copies`: the user's manual tags, rating, score,
quarantine and cover pins carry over, then the outer copy is dropped.

Sync, like the scanner that calls it.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import sync_conn, sync_tx
from . import activity, image_tags

logger = logging.getLogger("moire.library_nesting")

_ROOTS_TTL_S = 5.0
_cache: tuple[float, list[tuple[str, str]]] | None = None
_cache_lock = threading.Lock()


def path_key(path: str | os.PathLike) -> str:
    """One spelling per folder: normalized, and case-folded where the OS is."""
    return os.path.normcase(os.path.normpath(str(path)))


def is_inside(child: str, parent: str) -> bool:
    """Whether folder key ``child`` is strictly below folder key ``parent``."""
    return child != parent and child.startswith(parent.rstrip(os.sep) + os.sep)


def _under_any(key: str, roots: list[str]) -> bool:
    return any(key == r or is_inside(key, r) for r in roots)


def invalidate() -> None:
    """Forget the cached library roots: call after adding, moving or removing
    a library."""
    global _cache
    with _cache_lock:
        _cache = None


def _roots(*, fresh: bool) -> list[tuple[str, str]]:
    """Every library as ``(id, folder key)``. Cached briefly for the watcher,
    which asks once per file event; a scan asks ``fresh``."""
    global _cache
    with _cache_lock:
        if not fresh and _cache and time.monotonic() - _cache[0] < _ROOTS_TTL_S:
            return _cache[1]
    with sync_conn() as conn:
        rows = conn.execute(sa.select(t.libraries.c._id, t.libraries.c.path)).fetchall()
    roots = [(r._id, path_key(r.path)) for r in rows if r.path]
    with _cache_lock:
        _cache = (time.monotonic(), roots)
    return roots


def nested_roots(
    library_id: str, root: str | os.PathLike, *, fresh: bool = True
) -> list[str]:
    """The folder keys of the other libraries inside ``root``."""
    me = path_key(root)
    return [
        key
        for lib_id, key in _roots(fresh=fresh)
        if lib_id != library_id and is_inside(key, me)
    ]


def skip_dirs(dirpath: str, dirnames: list[str], roots: list[str]) -> list[str]:
    """``os.walk``'s ``dirnames`` without the folders other libraries own."""
    if not roots:
        return dirnames
    return [
        d for d in dirnames if not _under_any(path_key(os.path.join(dirpath, d)), roots)
    ]


def owned_by_nested(
    library_id: str, root: str | os.PathLike, path: str | os.PathLike
) -> bool:
    """Whether ``path`` (under ``root``) lies in another library inside it."""
    roots = nested_roots(library_id, root, fresh=False)
    return bool(roots) and _under_any(path_key(path), roots)


def under_nested(paths: dict[str, str | None], roots: list[str]) -> set[str]:
    """The ids, of ``{id: file path}``, whose file lies in one of ``roots``."""
    if not roots:
        return set()
    return {i for i, p in paths.items() if p and _under_any(path_key(p), roots)}


# --- Folding outer copies into the inner library -------------------------------


@dataclass
class _Lib:
    id: str
    path: str
    key: str
    settled: bool  # scanned at least once and not scanning now


def _like_prefix(path: str) -> str:
    folder = str(Path(path))
    if not folder.endswith(os.sep):
        folder += os.sep
    return folder.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _merged(inner: sa.Row, outer: sa.Row) -> tuple[list[str], dict]:
    """The inner row's tags and columns with the outer copy's curation added:
    manual tags always, AI tags (and their scores) when the inner row has none
    yet, and the rating, score and quarantine the inner row lacks."""
    tags = list(inner.tags or [])
    extra: dict = {}
    outer_tags = list(outer.tags or [])
    outer_ai = [
        x
        for x in outer_tags
        if not image_tags.is_manual(x) and not image_tags.is_prompt(x)
    ]
    if outer_ai and not inner.has_ai_tags:
        tags = image_tags.with_replaced_ai(tags, outer_ai)
        extra["ai"] = outer.ai
    tags = image_tags.union_tags(
        tags, [x for x in outer_tags if image_tags.is_manual(x)]
    )
    if not inner.rating and outer.rating:
        extra["rating"] = outer.rating
    if not inner.score and outer.score:
        extra["score"] = outer.score
    if outer.quarantined and not inner.quarantined:
        extra["quarantined"] = True
    return tags, extra


def adopt_nested_copies() -> int:
    """Fold every outer library's copies of a nested library's files into the
    nested library's rows. A copy whose file the nested library hasn't
    indexed waits while that library has yet to finish a scan, and is dropped
    once it has (the file is gone). Returns how many copies were dropped."""
    with sync_conn() as conn:
        rows = conn.execute(
            sa.select(
                t.libraries.c._id,
                t.libraries.c.path,
                t.libraries.c.last_scanned,
                t.libraries.c.scanning,
            )
        ).fetchall()
    libs = [
        _Lib(r._id, r.path, path_key(r.path), bool(r.last_scanned) and not r.scanning)
        for r in rows
        if r.path
    ]
    dropped = 0
    for outer in libs:
        inner_libs = [i for i in libs if is_inside(i.key, outer.key)]
        if inner_libs:
            dropped += _adopt_from(outer, inner_libs)
    if dropped:
        from . import tag_index

        tag_index.invalidate()
    return dropped


def _adopt_from(outer: _Lib, inner_libs: list[_Lib]) -> int:
    im = t.images
    with sync_conn() as conn:
        copies = conn.execute(
            sa.select(im.c._id, im.c.path).where(
                im.c.library_id == outer.id,
                sa.or_(
                    *(
                        im.c.path.like(_like_prefix(i.path), escape="\\")
                        for i in inner_libs
                    )
                ),
            )
        ).fetchall()
    # Each copy to the innermost library holding its file.
    plan: list[tuple[str, str, str]] = []  # (outer copy's id, the inner row's id, file)
    for c in copies:
        key = path_key(c.path)
        holders = [i for i in inner_libs if is_inside(key, i.key)]
        if not holders:
            continue
        owner = max(holders, key=lambda i: len(i.key))
        try:
            rel = Path(c.path).relative_to(Path(owner.path))
        except ValueError:
            continue
        plan.append((c._id, f"{owner.id}:{rel}", c.path))
    if not plan:
        return 0

    with activity.track("fold", library_id=outer.id, total=len(plan)) as task:
        return _adopt_plan(outer, inner_libs, plan, task)


def _adopt_plan(
    outer: _Lib,
    inner_libs: list[_Lib],
    plan: list[tuple[str, str, str]],
    task: activity.Task,
) -> int:
    im = t.images
    dropped: list[str] = []
    thumbs: list[str] = []
    settled = {i.id for i in inner_libs if i.settled}
    for start in range(0, len(plan), 200):
        chunk = plan[start : start + 200]
        with sync_tx() as conn:
            ids = [i for outer_id, inner_id, _ in chunk for i in (outer_id, inner_id)]
            found = {
                r._id: r
                for r in conn.execute(
                    sa.select(
                        im.c._id,
                        im.c.tags,
                        im.c.has_ai_tags,
                        im.c.ai,
                        im.c.rating,
                        im.c.score,
                        im.c.quarantined,
                        im.c.thumb_key,
                    ).where(im.c._id.in_(ids))
                )
            }
            gone: list[str] = []
            for outer_id, inner_id, file in chunk:
                copy = found.get(outer_id)
                if copy is None:
                    continue
                inner = found.get(inner_id)
                if inner is not None:
                    tags, extra = _merged(inner, copy)
                    image_tags.rewrite_tags_sync(conn, inner._id, tags, extra)
                    conn.execute(
                        sa.update(t.tag_meta)
                        .where(t.tag_meta.c.thumb_image_id == outer_id)
                        .values(thumb_image_id=inner._id)
                    )
                elif inner_id.split(":", 1)[0] not in settled or os.path.exists(file):
                    # Not indexed there yet (or it failed to): keep the copy,
                    # tags and all, until it is. A copy of a deleted file goes.
                    continue
                gone.append(outer_id)
                if copy.thumb_key:
                    thumbs.append(copy.thumb_key)
            if gone:
                conn.execute(sa.delete(im).where(im.c._id.in_(gone)))
                conn.execute(
                    sa.delete(t.image_gen_raw).where(t.image_gen_raw.c._id.in_(gone))
                )
                dropped.extend(gone)
            task.advance(len(chunk))
    if dropped:
        with sync_tx() as conn:
            count = conn.execute(
                sa.select(sa.func.count())
                .select_from(im)
                .where(im.c.library_id == outer.id)
            ).scalar()
            conn.execute(
                sa.update(t.libraries)
                .where(t.libraries.c._id == outer.id)
                .values(indexed_count=count)
            )
        from .storage_fs import delete_thumb

        for key in thumbs:
            try:
                delete_thumb(key)
            except Exception:
                pass  # a leftover thumbnail only wastes space
        logger.info(
            "Folded %d images of library %s into the libraries inside it",
            len(dropped),
            outer.id,
        )
    return len(dropped)
