import sys

import pytest
from pydantic import ValidationError

from src.models.library import LibraryIn, LibraryUpdate


def test_strips_wrapping_quotes(tmp_path):
    lib = LibraryIn(path=f'"{tmp_path}"')
    assert lib.path == str(tmp_path)


def test_strips_wrapping_single_quotes(tmp_path):
    lib = LibraryIn(path=f"'{tmp_path}'")
    assert lib.path == str(tmp_path)


def test_accepts_absolute_path(tmp_path):
    lib = LibraryIn(path=str(tmp_path))
    assert lib.path == str(tmp_path)


@pytest.mark.parametrize("raw", ["", "   ", '""', "''", '"  "'])
def test_rejects_empty_or_whitespace_only(raw):
    # A quoted-empty path sanitizes to "", and Path("") resolves to the
    # process's own cwd to pathlib rather than meaning "no path"; this is
    # what let a POST with `path: '""'` scan the backend's own cwd.
    with pytest.raises(ValidationError):
        LibraryIn(path=raw)


def test_rejects_bare_relative_path():
    # A relative name's meaning depends on the backend's cwd rather than
    # naming a fixed location.
    with pytest.raises(ValidationError):
        LibraryIn(path="some-relative-dir")


@pytest.mark.skipif(
    sys.platform != "win32", reason="drive-relative paths are a Windows concept"
)
def test_rejects_windows_drive_relative_path():
    # "C:" (no trailing separator) is drive-relative, not absolute; it names
    # "the current directory on drive C", which also depends on process cwd.
    with pytest.raises(ValidationError):
        LibraryIn(path="C:")


def test_update_allows_omitted_path():
    upd = LibraryUpdate(name="renamed")
    assert upd.path is None


def test_update_validates_path_when_present(tmp_path):
    upd = LibraryUpdate(path=f'"{tmp_path}"')
    assert upd.path == str(tmp_path)

    with pytest.raises(ValidationError):
        LibraryUpdate(path="")
