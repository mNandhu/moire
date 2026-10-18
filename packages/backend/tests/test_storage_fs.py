"""Regression tests for the thumbnail filesystem store.

The thumb key embeds the image id (``{library_id}:{relpath}``). The ``:``
separator is reserved on Windows (NTFS Alternate-Data-Stream separator), so the
on-disk path must be sanitized while the stored key stays the logical id.
"""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def fs(tmp_path, monkeypatch):
    """storage_fs pointed at a temp thumb root."""
    from src.core.config import settings
    from src.services import storage_fs

    monkeypatch.setattr(
        type(settings),
        "thumb_root_path",
        property(lambda self: tmp_path),
        raising=False,
    )
    importlib.reload(storage_fs)  # pick up the patched root
    return storage_fs


def test_put_then_read_thumb_with_colon_in_image_id(fs):
    # image_id carries the `{library_id}:{relpath}` colon, and on Windows the
    # relpath separator is a backslash.
    library_id = "lib123"
    image_id = "lib123:sub\\ComfyUI_00002_.png"

    key = fs.put_thumb(library_id, image_id, b"thumb-bytes")

    # The returned key is the literal on-disk path: the reserved `:` is gone, so
    # readers use it verbatim without a matching transform to keep in sync.
    assert ":" not in key
    path = fs.thumb_path(key)
    assert path is not None
    assert path.read_bytes() == b"thumb-bytes"
    assert ":" not in path.name


def test_delete_thumb_with_colon_in_image_id(fs):
    key = fs.put_thumb("lib123", "lib123:a.png", b"x")
    assert fs.thumb_path(key) is not None
    fs.delete_thumb(key)
    assert fs.thumb_path(key) is None


def test_empty_key_rejected(fs):
    with pytest.raises(ValueError):
        fs.thumb_path("")
    with pytest.raises(ValueError):
        fs.thumb_path("/")
