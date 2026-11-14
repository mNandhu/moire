"""The daily PyPI update check: which release counts, when it asks, and what
GET /version reports. PyPI is never called: `fetch_latest` is replaced."""

from __future__ import annotations

import time

import httpx
import pytest
from packaging.version import Version

from moire.core.config import settings
from moire.services import update_check as uc


@pytest.fixture
def installed(monkeypatch):
    """An installed copy at 0.2.1 (tests run from a checkout otherwise)."""
    monkeypatch.setattr(uc, "IS_CHECKOUT", False)
    monkeypatch.setattr(uc, "__version__", "0.2.1")
    monkeypatch.setattr(uc, "install_kind", lambda: "uv")
    monkeypatch.setattr(settings, "update_check", True)
    monkeypatch.setattr(uc, "FORCE_MIN_S", 0)
    monkeypatch.setattr(uc, "_last_try", 0.0)
    uc._announced.clear()


@pytest.fixture
def pypi(monkeypatch):
    """Answers for fetch_latest, and how often it was asked."""
    state = {"latest": "0.3.0", "calls": 0}

    async def fake(current):
        state["calls"] += 1
        return state["latest"]

    monkeypatch.setattr(uc, "fetch_latest", fake)
    return state


def _files(*yanked: bool) -> list[dict]:
    return [{"filename": "x.whl", "yanked": y} for y in yanked]


def test_latest_release_skips_yanked_and_prereleases():
    data = {
        "releases": {
            "0.2.1": _files(False),
            "0.3.0": _files(False),
            "0.4.0": _files(True, True),  # every file yanked
            "0.5.0rc1": _files(False),
            "0.6.0": [],  # no files uploaded
            "not-a-version": _files(False),
        }
    }
    assert uc.latest_release(data, Version("0.2.1")) == "0.3.0"
    # Someone already on a pre-release hears of newer ones.
    assert uc.latest_release(data, Version("0.3.0b1")) == "0.5.0rc1"


def test_latest_release_handles_garbage():
    assert uc.latest_release({}, Version("0.2.1")) is None
    assert uc.latest_release({"releases": None}, Version("0.2.1")) is None
    assert uc.latest_release({"releases": {"1.0": "x"}}, Version("0.2.1")) is None


async def test_fetch_latest_fails_quietly(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)  # not published yet

    real = httpx.AsyncClient

    def client(**kw):
        return real(transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(uc.httpx, "AsyncClient", client)
    assert await uc.fetch_latest(Version("0.2.1")) is None

    def bad_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>")

    monkeypatch.setattr(
        uc.httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(bad_json), **kw),
    )
    assert await uc.fetch_latest(Version("0.2.1")) is None


def test_unknown_version_never_compares(monkeypatch):
    monkeypatch.setattr(uc, "__version__", "0.0.0")
    assert uc.current_version() is None
    monkeypatch.setattr(uc, "__version__", "garbage")
    assert uc.current_version() is None


async def test_check_asks_once_a_day(temp_db, installed, pypi, capsys):
    await uc.check()
    assert pypi["calls"] == 1
    assert "Update available: Moiré 0.3.0" in capsys.readouterr().out
    # Within a day: the stored answer stands.
    await uc.check()
    assert pypi["calls"] == 1
    # Check now asks regardless; the line is printed once per version.
    await uc.check(force=True)
    assert pypi["calls"] == 2
    assert capsys.readouterr().out == ""
    # A day later it asks again.
    doc = await uc.app_settings.read(uc.ROW)
    doc["checked_at"] = time.time() - uc.CHECK_EVERY_S - 1
    await uc.app_settings.write(uc.ROW, doc)
    await uc.check()
    assert pypi["calls"] == 3


async def test_check_respects_switch_checkout_and_env(
    temp_db, installed, pypi, monkeypatch
):
    await uc.set_enabled(False)
    await uc.check(force=True)
    assert pypi["calls"] == 0
    await uc.set_enabled(True)

    monkeypatch.setattr(settings, "update_check", False)
    await uc.check(force=True)
    assert pypi["calls"] == 0
    monkeypatch.setattr(settings, "update_check", True)

    monkeypatch.setattr(uc, "IS_CHECKOUT", True)
    await uc.check(force=True)
    assert pypi["calls"] == 0


async def test_failed_check_keeps_last_answer(temp_db, installed, pypi):
    await uc.check()
    first = (await uc.status())["checked_at"]
    pypi["latest"] = None  # PyPI unreachable
    await uc.check(force=True)
    s = await uc.status()
    assert s["latest"] == "0.3.0"
    # Not counted as a check: the loop tries again within the hour.
    assert s["checked_at"] == first


async def test_failed_first_check_retries_next_wake(temp_db, installed, pypi):
    pypi["latest"] = None
    await uc.check()
    pypi["latest"] = "0.3.0"
    await uc.check()
    assert pypi["calls"] == 2
    assert (await uc.status())["latest"] == "0.3.0"


async def test_check_now_is_throttled(temp_db, installed, pypi, monkeypatch):
    monkeypatch.setattr(uc, "FORCE_MIN_S", 60)
    await uc.check(force=True)
    await uc.check(force=True)
    assert pypi["calls"] == 1


async def test_switch_off_midflight_stores_nothing(
    temp_db, installed, monkeypatch, capsys
):
    async def slow(current):
        await uc.set_enabled(False)  # the user switches it off meanwhile
        return "0.3.0"

    monkeypatch.setattr(uc, "fetch_latest", slow)
    await uc.check(force=True)
    doc = await uc.app_settings.read(uc.ROW)
    assert "latest" not in doc and "checked_at" not in doc
    assert capsys.readouterr().out == ""


def test_install_kind_reads_uv_receipt(tmp_path, monkeypatch):
    monkeypatch.setattr(uc, "IS_CHECKOUT", False)
    monkeypatch.delenv("MOIRE_INSTALL", raising=False)
    # Windows' default uv tool folder has no "/uv/tools/" in it.
    env = tmp_path / "uv" / "data" / "tools" / "moire-studio"
    env.mkdir(parents=True)
    monkeypatch.setattr(uc.sys, "prefix", str(env))
    assert uc.install_kind() == "pip"
    (env / "uv-receipt.toml").write_text("")
    assert uc.install_kind() == "uv"
    monkeypatch.setenv("MOIRE_INSTALL", "docker")
    assert uc.install_kind() == "docker"


async def test_version_endpoint(client, installed, pypi):
    r = await client.get("/version")
    assert r.status_code == 200
    body = r.json()
    assert body["current"] == "0.2.1"
    assert body["update_available"] is False
    assert body["can_check"] is True and body["enabled"] is True

    body = (await client.post("/version/check")).json()
    assert body["update_available"] is True
    assert body["latest"] == "0.3.0"
    assert body["command"] == "uv tool upgrade moire-studio"
    assert body["release_url"].endswith("/tag/v0.3.0")

    # Switched off: the known release is no longer shown.
    body = (await client.put("/version", json={"enabled": False})).json()
    assert body["enabled"] is False
    assert body["update_available"] is False

    # Same version: nothing to show.
    await client.put("/version", json={"enabled": True})
    pypi["latest"] = "0.2.1"
    body = (await client.post("/version/check")).json()
    assert body["update_available"] is False and body["latest"] is None


async def test_checkout_reports_no_check(client, monkeypatch):
    monkeypatch.setattr(uc, "IS_CHECKOUT", True)
    monkeypatch.setattr(uc, "install_kind", lambda: "checkout")
    body = (await client.get("/version")).json()
    assert body["can_check"] is False
    assert body["command"] is None
    assert body["update_available"] is False
