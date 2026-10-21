from __future__ import annotations

import os
import shutil
import uuid
from io import BytesIO
from pathlib import Path

from PIL import Image as PILImage

from ..core.config import settings

# The small copy's short side: enough for a crop-filled preview of ~100px at
# 2x pixel density, a fraction of the full thumbnail's bytes.
SMALL_SIDE = 256
_SMALL_QUALITY = 80


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
    _write_atomic(_safe_path(key), data)
    # A rescan rewrites the thumbnail: its small copy is remade on next ask.
    _safe_path(small_key(key)).unlink(missing_ok=True)
    return key


def _write_atomic(dst: Path, data: bytes) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    # Temp file in the SAME dir → same filesystem → os.replace is atomic. Unique
    # per write: two requests may make the same small copy at once.
    tmp = dst.with_name(f"{dst.name}.tmp.{os.getpid()}.{uuid.uuid4().hex}")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dst)
    finally:
        tmp.unlink(missing_ok=True)


def small_key(key: str) -> str:
    """Where a thumbnail's small copy lives: beside it, so `delete_by_prefix`
    takes both. Thumb keys end `.<image ext>.webp`, so `.small.webp` can't be
    another image's key."""
    return f"{key.removesuffix('.webp')}.small.webp"


def thumb_path(key: str) -> Path | None:
    """Return the on-disk path for a thumb key, or None if it doesn't exist."""
    p = _safe_path(key)
    return p if p.is_file() else None


def small_thumb_path(key: str) -> Path | None:
    """The small copy of a thumbnail, for postage-stamp previews: made from the
    thumbnail on first ask, and again when the thumbnail is newer. None if the
    thumbnail isn't on disk."""
    src = thumb_path(key)
    if src is None:
        return None
    dst = _safe_path(small_key(key))
    try:
        if dst.stat().st_mtime_ns >= src.stat().st_mtime_ns:
            return dst
    except FileNotFoundError:
        pass
    with PILImage.open(src) as img:
        w, h = img.size
        scale = SMALL_SIDE / min(w, h)
        if scale < 1:
            img.thumbnail((round(w * scale), round(h * scale)))
        buf = BytesIO()
        img.save(buf, format="WEBP", quality=_SMALL_QUALITY)
    _write_atomic(dst, buf.getvalue())
    return dst


def delete_thumb(key: str) -> None:
    """Delete a single thumbnail file and its small copy (best-effort)."""
    _safe_path(key).unlink(missing_ok=True)
    _safe_path(small_key(key)).unlink(missing_ok=True)


def delete_by_prefix(prefix: str) -> None:
    """Delete all thumbnails under a prefix (e.g. `library_id/`)."""
    target = _safe_path(prefix.rstrip("/"))
    shutil.rmtree(target, ignore_errors=True)
