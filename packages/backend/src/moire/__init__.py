"""Moiré: a local gallery for organizing, tagging and generating AI images."""

from importlib.metadata import PackageNotFoundError, version

# The PyPI distribution name; the import package and the command are `moire`.
DIST_NAME = "moire-studio"

try:
    __version__ = version(DIST_NAME)
except PackageNotFoundError:  # running from a tree that was never synced
    __version__ = "0.0.0"
