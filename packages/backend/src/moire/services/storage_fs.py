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
    dst = _safe_path(key)
    try:
        # A rescan that makes the same bytes leaves the file, so its mtime
        # (and the thumbnail's versioned URL) stays put.
        if dst.stat().st_size == len(data) and dst.read_bytes() == data:
            return key
    except FileNotFoundError:
        pass
    _write_atomic(dst, data)
    # A rescan rewrites the thumbnail: its small copy is remade on next ask.
    _safe_path(small_key(key)).unlink(missing_ok=True)
    return key


def thumb_key(image_id: str) -> str:
    """The key `put_thumb` writes an image's thumbnail under."""
    return f"{image_id.split(':', 1)[0]}/{image_id}.webp".replace(":", "_")


def _write_atomic(dst: Path, data: bytes, mtime_ns: int | None = None) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    # Temp file in the SAME dir → same filesystem → os.replace is atomic. Unique
    # per write: two requests may make the same small copy at once.
    tmp = dst.with_name(f"{dst.name}.tmp.{os.getpid()}.{uuid.uuid4().hex}")
    try:
        tmp.write_bytes(data)
        if mtime_ns is not None:
            os.utime(tmp, ns=(mtime_ns, mtime_ns))
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


# Thumbnails Pillow couldn't read, by key, with the thumbnail's mtime then:
# served as themselves without another try until the thumbnail changes.
_unreadable: dict[str, int] = {}


def thumb_stat(key: str) -> os.stat_result | None:
    """The thumbnail file's stat, or None if it isn't on disk. Run for every
    thumbnail URL in a list, so the traversal guard is lexical: `resolve()`
    walks each path component and costs ~15x the stat."""
    root = os.path.abspath(_root())
    p = os.path.normpath(os.path.join(root, key))
    if not key.strip("/") or not p.startswith(root + os.sep):
        raise ValueError(f"thumb key escapes root: {key!r}")
    try:
        return os.stat(p)
    except FileNotFoundError:
        return None


def small_thumb_path(key: str) -> Path | None:
    """The small copy of a thumbnail, for postage-stamp previews: made from the
    thumbnail on first ask, and again when the thumbnail changes. The thumbnail
    itself when it is already that small or can't be read; None if it isn't on
    disk. Raises only when the copy can't be written."""
    src = thumb_path(key)
    if src is None:
        return None
    made = src.stat().st_mtime_ns
    dst = _safe_path(small_key(key))
    # The copy carries the thumbnail's mtime: a copy made from an older
    # thumbnail (one a rescan replaced mid-encode) never matches.
    try:
        if dst.stat().st_mtime_ns == made:
            return dst
    except FileNotFoundError:
        pass
    if _unreadable.get(key) == made:
        return src
    try:
        with PILImage.open(src) as img:
            w, h = img.size
            if min(w, h) <= SMALL_SIDE:
                return src
            scale = SMALL_SIDE / min(w, h)
            img.thumbnail((round(w * scale), round(h * scale)))
            buf = BytesIO()
            img.save(buf, format="WEBP", quality=_SMALL_QUALITY)
    except (OSError, ValueError, SyntaxError):
        if len(_unreadable) > 10_000:
            _unreadable.clear()
        _unreadable[key] = made
        return src
    _write_atomic(dst, buf.getvalue(), mtime_ns=made)
    return dst


def delete_thumb(key: str) -> None:
    """Delete a single thumbnail file and its small copy (best-effort)."""
    _safe_path(key).unlink(missing_ok=True)
    _safe_path(small_key(key)).unlink(missing_ok=True)


def delete_by_prefix(prefix: str) -> None:
    """Delete all thumbnails under a prefix (e.g. `library_id/`)."""
    target = _safe_path(prefix.rstrip("/"))
    shutil.rmtree(target, ignore_errors=True)
