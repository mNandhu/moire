"""Handing freed memory back to the OS.

glibc keeps freed heap pages in its arenas, so a process's RSS only ratchets
up after a scan or an AI job even though Python freed the objects.
``malloc_trim(0)`` returns the free pages. Only glibc has it: everywhere else
(Windows, macOS, musl) :func:`trim` does nothing.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import logging

logger = logging.getLogger("moire.memory")

_UNSET = object()
_malloc_trim = _UNSET


def _find_malloc_trim():
    try:
        name = ctypes.util.find_library("c")
        if not name:
            return None
        fn = ctypes.CDLL(name).malloc_trim  # AttributeError off glibc
        fn.argtypes = [ctypes.c_size_t]
        fn.restype = ctypes.c_int
        return fn
    except Exception:
        return None


def trim() -> bool:
    """Ask glibc to return free heap pages to the OS. True when it ran; never
    raises."""
    global _malloc_trim
    try:
        if _malloc_trim is _UNSET:
            _malloc_trim = _find_malloc_trim()
        if _malloc_trim is None:
            return False
        _malloc_trim(0)
        return True
    except Exception:
        logger.debug("malloc_trim failed", exc_info=True)
        return False
