from __future__ import annotations

import os
import shutil
from pathlib import Path

from ..core.config import settings


def _root() -> Path:
    return settings.thumb_root_path


def ensure_thumb_root() -> None:
    """Create the thumbnail root dir. Run at startup (lifespan)."""
    _root().mkdir(parents=True, exist_ok=True)


def _safe_path(key: str) -> Path:
    """Resolve a thumb key to an absolute path, guarding against traversal.

    ``key`` is DB-controlled today, but this assertion keeps a malformed or
    hostile ``thumb_key`` from escaping ``thumb_root``.
    """
    if not key or not key.strip("/"):
        # Empty/`/`-only key would resolve to the root itself; refuse, so a
        # future caller can't trigger `rmtree(root)` and wipe the whole store.
        raise ValueError(f"empty thumb key: {key!r}")
    root = _root().resolve()
    p = (root / key).resolve()
    if root not in p.parents:
        raise ValueError(f"thumb key escapes root: {key!r}")
    return p


def put_thumb(library_id: str, image_id: str, data: bytes) -> str:
    """Write thumbnail bytes to disk atomically; returns the object key.

    The image id is ``{library_id}:{relpath}``; the ``:`` separator was fine for
    the old MinIO object store but is reserved on Windows (the NTFS Alternate-
    Data-Stream separator), so it's replaced here. The returned key is the literal
    on-disk path, so readers (`thumb_path`/`delete_thumb`) use it verbatim with no
    matching transform to keep in sync.
    """
    key = f"{library_id}/{image_id}.webp".replace(":", "_")
    dst = _safe_path(key)
    dst.parent.mkdir(parents=True, exist_ok=True)
    # Temp file in the SAME dir → same filesystem → os.replace is atomic.
    tmp = dst.with_name(f"{dst.name}.tmp.{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, dst)
    return key


def thumb_path(key: str) -> Path | None:
    """Return the on-disk path for a thumb key, or None if it doesn't exist."""
    p = _safe_path(key)
    return p if p.is_file() else None


def delete_thumb(key: str) -> None:
    """Delete a single thumbnail file (best-effort)."""
    _safe_path(key).unlink(missing_ok=True)


def delete_by_prefix(prefix: str) -> None:
    """Delete all thumbnails under a prefix (e.g. `library_id/`)."""
    target = _safe_path(prefix.rstrip("/"))
    shutil.rmtree(target, ignore_errors=True)
