"""Whether a newer Moiré is on PyPI, for the sidebar's "Update available".

A background loop asks PyPI at most once a day and keeps the answer in the
``app_settings`` row "update_check" (``{enabled, latest, checked_at}``), so a
restart doesn't ask again and a copy left running for days still hears of a
release. The only request is a GET of the package's public JSON; nothing about
this install is sent. It never runs in a source checkout, and is off when the
user turns it off in Settings or ``UPDATE_CHECK=false`` is set.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from typing import Any

import httpx
from packaging.version import InvalidVersion, Version

from .. import DIST_NAME, __version__
from ..core.config import IS_CHECKOUT, settings
from . import app_settings

logger = logging.getLogger("moire")

ROW = "update_check"
PYPI_URL = f"https://pypi.org/pypi/{DIST_NAME}/json"
RELEASES_URL = "https://github.com/mNandhu/moire/releases"
CHECK_EVERY_S = 24 * 3600
# Check now asks PyPI at most this often, however often it is pressed.
FORCE_MIN_S = 60
# How often the loop wakes to see whether a day has passed.
WAKE_EVERY_S = 3600
TIMEOUT_S = 5.0


def install_kind() -> str:
    """How this copy was installed, which decides the upgrade command."""
    if IS_CHECKOUT:
        return "checkout"
    if os.environ.get("MOIRE_INSTALL") == "docker":
        return "docker"
    # `uv tool install` leaves a receipt in the tool's environment, wherever
    # UV_TOOL_DIR or the platform puts it (Windows: %APPDATA%\uv\data\tools).
    if os.path.isfile(os.path.join(sys.prefix, "uv-receipt.toml")):
        return "uv"
    prefix = sys.prefix.replace("\\", "/").lower()
    if "/pipx/" in prefix:
        return "pipx"
    return "pip"


UPGRADE_COMMANDS = {
    "uv": f"uv tool upgrade {DIST_NAME}",
    "pipx": f"pipx upgrade {DIST_NAME}",
    "pip": f"pip install -U {DIST_NAME}",
    "docker": "git pull && docker compose up --build",
}


def _parse(v: str | None) -> Version | None:
    try:
        return Version(v) if v else None
    except InvalidVersion:
        return None


def current_version() -> Version | None:
    """The running version, or None when it can't be compared (unparsable, or
    the 0.0.0 a never-installed tree reports): then nothing is ever newer."""
    v = _parse(__version__)
    return v if v and v != Version("0.0.0") else None


def latest_release(data: dict[str, Any], current: Version) -> str | None:
    """The newest release in PyPI's JSON: yanked ones skipped, pre-releases
    only for someone already running one."""
    best: Version | None = None
    for raw, files in (data.get("releases") or {}).items():
        v = _parse(raw)
        if v is None or not isinstance(files, list) or not files:
            continue
        if all(isinstance(f, dict) and f.get("yanked") for f in files):
            continue
        if v.is_prerelease and not current.is_prerelease:
            continue
        if best is None or v > best:
            best = v
    return str(best) if best else None


async def fetch_latest(current: Version) -> str | None:
    """Ask PyPI; None on any failure (offline, not published yet, bad JSON)."""
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT_S, headers={"User-Agent": f"moire/{__version__}"}
        ) as client:
            r = await client.get(PYPI_URL)
            r.raise_for_status()
            data = r.json()
        return latest_release(data, current) if isinstance(data, dict) else None
    except Exception as e:  # never worth more than a debug line
        logger.debug("Update check failed: %s", e)
        return None


def _allowed() -> Version | None:
    """The running version when checking may happen here at all: not off by
    UPDATE_CHECK, not a checkout, and a version that compares."""
    if not settings.update_check or IS_CHECKOUT:
        return None
    return current_version()


async def _doc() -> dict[str, Any]:
    return dict(await app_settings.read(ROW) or {})


async def set_enabled(enabled: bool) -> None:
    doc = await _doc()
    doc["enabled"] = enabled
    await app_settings.write(ROW, doc)


_announced: set[str] = set()
_last_try = 0.0


def _announce(latest: str) -> None:
    """One line in the terminal `moire run` was started from, once per version."""
    if latest in _announced:
        return
    _announced.add(latest)
    cmd = UPGRADE_COMMANDS.get(install_kind())
    tail = f" Run: {cmd}" if cmd else ""
    print(
        f"  Update available: Moiré {latest} (you have {__version__}).{tail}",
        flush=True,
    )


async def check(force: bool = False) -> None:
    """Ask PyPI if it's allowed, switched on and (unless forced) a day old."""
    global _last_try
    current = _allowed()
    if current is None:
        return
    doc = await _doc()
    if not doc.get("enabled", True):
        return
    now = time.time()
    if force:
        if now - _last_try < FORCE_MIN_S:
            return
    elif now - float(doc.get("checked_at") or 0) < CHECK_EVERY_S:
        return
    _last_try = now
    latest = await fetch_latest(current)
    # A failed ask (offline, PyPI down, nothing published yet) leaves
    # checked_at alone, so the hourly loop tries again instead of in a day.
    if latest is None:
        return
    doc = await _doc()  # the switch may have moved while PyPI answered
    if not doc.get("enabled", True):
        return
    doc["latest"] = latest
    doc["checked_at"] = time.time()
    await app_settings.write(ROW, doc)
    if latest and Version(latest) > current:
        _announce(latest)


async def status() -> dict[str, Any]:
    """What the UI shows: this version, the newest known, and the switch."""
    doc = await _doc()
    current = current_version()
    kind = install_kind()
    enabled = bool(doc.get("enabled", True))
    latest = doc.get("latest") if enabled and _allowed() is not None else None
    lv = _parse(latest)
    newer = bool(current and lv and lv > current)
    return {
        "current": __version__,
        "latest": latest if newer else None,
        "update_available": newer,
        "release_url": f"{RELEASES_URL}/tag/v{latest}" if newer else None,
        "command": UPGRADE_COMMANDS.get(kind),
        "install_kind": kind,
        # Whether checking can happen here at all (not in a checkout, not
        # switched off by UPDATE_CHECK), and whether the user has it on.
        "can_check": _allowed() is not None,
        "enabled": enabled,
        "checked_at": doc.get("checked_at"),
    }


class UpdateChecker:
    """The background loop, started and stopped with the app."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None and _allowed() is not None:
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            try:
                await check()
            except Exception:
                logger.debug("Update check loop error", exc_info=True)
            await asyncio.sleep(WAKE_EVERY_S)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None


checker = UpdateChecker()
