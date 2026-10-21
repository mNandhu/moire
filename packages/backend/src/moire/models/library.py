from __future__ import annotations
import os
from pathlib import Path
from pydantic import BaseModel, Field, field_validator
from typing import Optional

_QUOTE_PAIRS = (('"', '"'), ("'", "'"))


def _sanitize_path(value: str) -> str:
    value = value.strip()
    while len(value) >= 2:
        for start, end in _QUOTE_PAIRS:
            if value[0] == start and value[-1] == end:
                value = value[1:-1].strip()
                break
        else:
            break
    return value


def normalize_path(path: str) -> str:
    """Canonical spelling of a library path: collapses `..`/`//` and drops a
    trailing separator (keeping a bare root like `/` or `C:\\`), so
    `D:/images/` and `D:/images` are the same library."""
    return os.path.normpath(path)


def validate_library_path(value: str) -> str:
    value = _sanitize_path(value)
    # A quoted-empty or whitespace-only path sanitizes to "", and Path("") is
    # the process's own cwd to pathlib, not "no path". Rejecting non-absolute
    # paths here also catches that (cwd is relative) along with bare relative
    # names and Windows drive-relative references ("C:", as opposed to
    # "C:\\"), whose meaning would otherwise depend on the backend's cwd
    # rather than naming a fixed location.
    if not value or not Path(value).is_absolute():
        raise ValueError(f"Path must be a non-empty absolute path: {value!r}")
    return normalize_path(value)


class LibraryIn(BaseModel):
    path: str
    name: Optional[str] = None

    @field_validator("path")
    @classmethod
    def _strip_quotes(cls, v: str) -> str:
        return validate_library_path(v)


class LibraryDiscoverIn(BaseModel):
    # Validated per entry by the discover service, so one bad line is reported
    # on its own row rather than failing the whole preview.
    paths: list[str] = Field(..., min_length=1, max_length=50)
    #: Offer each immediate subfolder as its own library.
    split_subdirs: bool = False

    @field_validator("paths")
    @classmethod
    def _drop_blank(cls, v: list[str]) -> list[str]:
        cleaned = [p for p in v if p.strip()]
        if not cleaned:
            raise ValueError("At least one folder path is required")
        return cleaned


class Library(BaseModel):
    id: str = Field(..., alias="_id")
    path: str
    name: Optional[str] = None

    class Config:
        populate_by_name = True


class LibraryUpdate(BaseModel):
    path: Optional[str] = None
    name: Optional[str] = None
    watch_enabled: Optional[bool] = None

    @field_validator("path")
    @classmethod
    def _strip_quotes(cls, v: Optional[str]) -> Optional[str]:
        return validate_library_path(v) if v is not None else v
