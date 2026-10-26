"""Where a request's outputs land: the library file a local ComfyUI wrote,
or a download into the output library for one on another machine."""

from __future__ import annotations

import os
from pathlib import Path, PurePath

from . import library_nesting


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
    key = library_nesting.path_key(path)
    best: tuple[str, str, int] | None = None
    for lib_id, root in libraries:
        rk = library_nesting.path_key(root)
        if library_nesting.is_inside(key, rk) and (best is None or len(rk) > best[2]):
            best = (lib_id, root, len(rk))
    if best is None:
        return None
    return f"{best[0]}:{os.path.relpath(os.path.normpath(path), os.path.normpath(best[1]))}"


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
