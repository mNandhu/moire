"""`moire run`'s "On your network" URL: printed only when other machines
can actually reach it."""

import subprocess

import pytest

from moire import cli


@pytest.fixture
def kernel(tmp_path, monkeypatch):
    """Sets the kernel release `_behind_wsl_nat` reads."""
    path = tmp_path / "osrelease"
    monkeypatch.setattr(cli, "_OSRELEASE", str(path))
    return path.write_text


@pytest.fixture
def wslinfo(monkeypatch):
    """Sets what `wslinfo --networking-mode` prints (None: not installed)."""

    def set_mode(mode: str | None) -> None:
        def run(cmd, **_):
            if mode is None:
                raise FileNotFoundError(cmd[0])
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{mode}\n")

        monkeypatch.setattr(cli.subprocess, "run", run)

    return set_mode


@pytest.fixture(autouse=True)
def lan_ip(monkeypatch):
    monkeypatch.setattr(cli, "_lan_ip", lambda: "192.168.1.20")


def test_ipv4_wildcard_on_plain_linux(kernel):
    kernel("6.8.0-45-generic\n")
    assert cli._network_url("0.0.0.0", 8001) == "http://192.168.1.20:8001"


def test_no_kernel_release_file_means_not_wsl(tmp_path, monkeypatch):
    # Windows and macOS have no /proc
    monkeypatch.setattr(cli, "_OSRELEASE", str(tmp_path / "missing"))
    assert cli._network_url("0.0.0.0", 8001) == "http://192.168.1.20:8001"


@pytest.mark.parametrize("host", ["127.0.0.1", "::", "::1", "192.168.1.20"])
def test_only_an_ipv4_wildcard_gets_a_network_url(kernel, host):
    kernel("6.8.0-45-generic\n")
    assert cli._network_url(host, 8001) is None


def test_wsl2_nat_has_no_reachable_address(kernel, wslinfo):
    kernel("6.18.54.1-microsoft-standard-WSL2\n")
    wslinfo("nat")
    assert cli._network_url("0.0.0.0", 8001) is None


def test_wsl2_mirrored_shares_windows_addresses(kernel, wslinfo):
    kernel("6.18.54.1-microsoft-standard-WSL2\n")
    wslinfo("mirrored")
    assert cli._network_url("0.0.0.0", 8001) == "http://192.168.1.20:8001"


def test_wsl2_without_wslinfo_is_treated_as_nat(kernel, wslinfo):
    kernel("5.15.90.1-microsoft-standard-WSL2\n")
    wslinfo(None)
    assert cli._network_url("0.0.0.0", 8001) is None


def test_wsl1_uses_windows_networking(kernel):
    kernel("4.4.0-19041-Microsoft\n")
    assert cli._network_url("0.0.0.0", 8001) == "http://192.168.1.20:8001"


def test_no_route_prints_nothing(kernel, monkeypatch):
    kernel("6.8.0-45-generic\n")
    monkeypatch.setattr(cli, "_lan_ip", lambda: None)
    assert cli._network_url("0.0.0.0", 8001) is None
