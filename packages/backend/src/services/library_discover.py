"""Dry run for adding libraries: which folders would become libraries, and how big.

The Add Library dialog accepts several folders at once and can split each into
one library per immediate subfolder. Nothing is written here. This only walks
the filesystem and compares against the already-registered library paths so the
UI can show (and let the user prune) the plan before committing it.

Counting is bounded: per candidate (`max_count` files, `time_budget_s` seconds)
and for the whole request (`total_budget_s`, with candidates counted in
parallel). Libraries often live on slow mounts (network shares, WSL
`/mnt/<drive>`), and a preview that takes minutes is worse than one that says
"5,000+" or "not counted".
"""

from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

from ..models.library import normalize_path, validate_library_path
from .scanner import is_image

__all__ = ["discover", "as_dicts", "normalize_path"]


def _is_within(child: str, parent: str) -> bool:
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        # Different drives on Windows.
        return False


@dataclass
class Candidate:
    path: str
    name: str
    #: Which requested folder this candidate came from.
    source: str
    image_count: int = 0
    #: True when counting stopped early; `image_count` is then a lower bound.
    count_capped: bool = False
    hidden: bool = False
    #: new | registered | overlap | empty
    status: str = "new"
    #: Human-readable reason for a non-"new" status.
    note: str | None = None
    #: Existing library this candidate conflicts with, when status != "new".
    conflict_path: str | None = None


@dataclass
class SourceReport:
    path: str
    ok: bool = True
    error: str | None = None
    #: Subfolders found (split mode only).
    subdir_count: int = 0
    #: Images directly inside the folder, not covered by per-subfolder libraries.
    loose_image_count: int = 0
    #: In split mode with no subfolders, the folder itself is offered instead.
    fell_back_to_root: bool = False
    candidates: list[Candidate] = field(default_factory=list)


def _count_images(root: str, *, max_count: int, deadline: float) -> tuple[int, bool]:
    n = 0
    if time.monotonic() > deadline:
        return 0, True
    for _dirpath, _dirs, files in os.walk(root):
        for f in files:
            # Same test the scanner applies, so the preview counts what a scan indexes.
            if is_image(Path(f)):
                n += 1
                if n >= max_count:
                    return n, True
        if time.monotonic() > deadline:
            return n, True
    return n, False


def _loose_images(root: str) -> int:
    try:
        with os.scandir(root) as it:
            return sum(1 for e in it if e.is_file() and is_image(Path(e.name)))
    except OSError:
        return 0


def _subdirs(root: str) -> list[os.DirEntry]:
    with os.scandir(root) as it:
        return sorted(
            (e for e in it if e.is_dir(follow_symlinks=True)),
            key=lambda e: e.name.lower(),
        )


def _classify(c: Candidate, existing: list[str]) -> None:
    for lib in existing:
        if c.path == lib:
            c.status, c.note, c.conflict_path = "registered", "Already a library", lib
            return
    for lib in existing:
        if _is_within(c.path, lib):
            c.status, c.note, c.conflict_path = (
                "overlap",
                "Inside an existing library. Its images are already indexed",
                lib,
            )
            return
        if _is_within(lib, c.path):
            c.status, c.note, c.conflict_path = (
                "overlap",
                "Contains an existing library. Those images would be indexed twice",
                lib,
            )
            return
    if c.image_count == 0 and not c.count_capped:
        c.status, c.note = "empty", "No images found"


def _classify_within_plan(cands: list[Candidate]) -> None:
    """Nested folders in the same request would index the same images twice
    (e.g. `/imgs` listed alongside `/imgs/portraits`)."""
    for c in cands:
        if c.status != "new":
            continue
        for o in cands:
            if o is c:
                continue
            if _is_within(c.path, o.path) or _is_within(o.path, c.path):
                c.status, c.note, c.conflict_path = (
                    "overlap",
                    "Overlaps another folder in this list. Images would be indexed twice",
                    o.path,
                )
                break


def discover(
    paths: Iterable[str],
    *,
    split_subdirs: bool,
    existing_paths: Iterable[str],
    max_count: int = 5000,
    time_budget_s: float = 2.0,
    total_budget_s: float = 20.0,
    workers: int = 8,
) -> list[SourceReport]:
    existing = [normalize_path(p) for p in existing_paths]
    reports: list[SourceReport] = []
    seen: set[str] = set()
    planned: set[str] = set()
    cands: list[Candidate] = []

    for raw in paths:
        # Validate per folder, so one mistyped line is flagged on its own row
        # instead of rejecting the whole preview.
        try:
            src = validate_library_path(raw)
        except ValueError:
            reports.append(
                SourceReport(path=raw.strip(), ok=False, error="Not an absolute path")
            )
            continue
        if src in seen:
            continue
        seen.add(src)
        rep = SourceReport(path=src)
        reports.append(rep)
        if not Path(src).is_dir():
            rep.ok, rep.error = False, "Not a directory or not reachable"
            continue

        targets: list[tuple[str, str, bool]] = []  # (path, name, hidden)
        if split_subdirs:
            try:
                subs = _subdirs(src)
            except OSError as e:
                rep.ok, rep.error = False, f"Cannot list folder: {e.strerror or e}"
                continue
            rep.subdir_count = len(subs)
            rep.loose_image_count = _loose_images(src)
            targets = [
                (normalize_path(e.path), e.name, e.name.startswith(".")) for e in subs
            ]
            if not targets:
                rep.fell_back_to_root = True
        if not targets:
            targets = [(src, Path(src).name or src, False)]

        for path, name, hidden in targets:
            # The same folder reached twice (listed directly and as a subfolder
            # of another listed folder) is offered once.
            if path in planned:
                continue
            planned.add(path)
            c = Candidate(path=path, name=name, source=src, hidden=hidden)
            rep.candidates.append(c)
            cands.append(c)

    # Count in parallel under one overall deadline; whatever doesn't start in
    # time comes back as "not counted" (0, capped) rather than stalling.
    overall = time.monotonic() + total_budget_s

    def _count(c: Candidate) -> None:
        deadline = min(time.monotonic() + time_budget_s, overall)
        c.image_count, c.count_capped = _count_images(
            c.path, max_count=max_count, deadline=deadline
        )

    if cands:
        with ThreadPoolExecutor(max_workers=max(1, min(workers, len(cands)))) as ex:
            list(ex.map(_count, cands))

    for c in cands:
        _classify(c, existing)
    _classify_within_plan(cands)
    return reports


def as_dicts(reports: list[SourceReport]) -> list[dict]:
    return [asdict(r) for r in reports]
