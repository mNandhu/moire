"""The named steps of a scan, tested directly."""

import os

import pytest
from PIL import Image

from moire.services import library_nesting, scanner


def test_walk_skips_nested_library_folders_and_returns_ids(tmp_path):
    (tmp_path / "in").mkdir()
    (tmp_path / "sub").mkdir()
    Image.new("RGB", (2, 2)).save(tmp_path / "a.png")
    Image.new("RGB", (2, 2)).save(tmp_path / "in" / "b.png")
    Image.new("RGB", (2, 2)).save(tmp_path / "sub" / "c.png")
    nested = [library_nesting.path_key(tmp_path / "in")]
    files, ids, errors = scanner._walk("L1", tmp_path, nested)
    assert sorted(p.name for p in files) == ["a.png", "c.png"]
    assert ids == {"L1:a.png", f"L1:sub{os.sep}c.png"}
    assert errors == []


def test_check_cancel_raises_the_dedicated_exception():
    scanner._check_cancel("nope")  # not cancelled: no-op
    with scanner._scan_lock:
        scanner._cancel_scans.add("Lc")
    try:
        with pytest.raises(scanner._Cancelled):
            scanner._check_cancel("Lc")
    finally:
        with scanner._scan_lock:
            scanner._cancel_scans.discard("Lc")
