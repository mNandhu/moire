"""What gets indexed, and the thumbnail recipe a scan renders for it.

:func:`is_image` is the one rule for which files are images (the scan, the
watcher and the add-library preview all ask it). :func:`make_thumb_bytes`
opens a file once for its thumbnail, BlurHash, dimensions and embedded
generation data; :func:`thumb_stamp` names the recipe so a rescan knows when
existing thumbnails are stale.
"""

from __future__ import annotations

import mimetypes
from io import BytesIO
from pathlib import Path

from PIL import Image as PILImage

from ..core.config import settings
from . import gen_metadata
from .blurhash import blurhash_for_image


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}


_THUMB_QUALITY = 85


# Bump when the thumbnail encoding changes in code (resampling, encoder
# options) so existing thumbnails are rebuilt on the next scan.
_THUMB_RECIPE = 1


def thumb_stamp() -> str:
    """Everything a scan derives from a file: the thumbnail recipe and the
    generation-metadata capture. A rescan skips unchanged files only while
    the library's last full scan ran with this same stamp, so changing the
    size/format settings, `_THUMB_RECIPE` or `gen_metadata.CAPTURE_VERSION`
    re-reads every file."""
    size = max(16, settings.thumb_max_size)
    return (
        f"{size}/webp/q{_THUMB_QUALITY}/r{_THUMB_RECIPE}"
        f"/c{gen_metadata.CAPTURE_VERSION}"
    )


def make_thumb_bytes(
    path: Path,
) -> tuple[bytes | None, str | None, int, int, dict | None]:
    """Render thumbnail bytes, a BlurHash placeholder, original dimensions, and
    embedded generation metadata from a single image open.

    Returns ``(thumb_bytes, blurhash, width, height, gen_raw)``; thumb/blurhash
    may be None on failure, dimensions 0 if the header couldn't be read, gen_raw
    None when the image carries no generation data.
    """
    try:
        with PILImage.open(path) as img:
            # Original dimensions come from the header (no full decode), read
            # them before draft()/thumbnail() shrink the in-memory image.
            width, height = img.size

            # Capture embedded generation metadata from the same open. The
            # format knowledge lives in gen_metadata, which owns both halves.
            gen_raw = gen_metadata.read_gen_raw(img)

            size = max(16, settings.thumb_max_size)
            # draft() lets the JPEG decoder emit a pre-shrunk image (1/2, 1/4,
            # 1/8 scale), so large sources decode several times faster. No-op
            # for non-JPEG formats.
            img.draft("RGB", (size, size))
            img.thumbnail((size, size))

            buf = BytesIO()
            img.save(buf, format="WEBP", quality=_THUMB_QUALITY)

            # BlurHash from the already-downsampled thumbnail (it shrinks to
            # ~64px internally, so the result is identical to encoding the
            # full-res image but far cheaper).
            bh = blurhash_for_image(img)
            return buf.getvalue(), bh, int(width), int(height), gen_raw
    except Exception:
        return None, None, 0, 0, None


# Editors/downloaders/generators stage output under these suffixes before the
# final rename; never index them.
_IGNORED_SUFFIXES = (".tmp", ".part", ".partial", ".crdownload", ".download")


def is_ignored(path: Path) -> bool:
    """Files no part of Moiré indexes whatever they hold: dotfiles (including
    macOS `._x.png` sidecars), `~` temp files and half-written downloads."""
    name = path.name
    if name.startswith((".", "~")):
        return True
    return path.suffix.lower() in _IGNORED_SUFFIXES


def is_image(path: Path) -> bool:
    """The one rule for what is indexed: the full scan, the watcher, single
    ingest and the add-library preview all ask this."""
    if is_ignored(path):
        return False
    if path.suffix.lower() in IMAGE_EXTS:
        return True
    mt, _ = mimetypes.guess_type(str(path))
    return mt is not None and mt.startswith("image/")
