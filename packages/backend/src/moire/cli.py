"""The `moire` command: `moire run` starts the app (API and UI on one port),
`moire paths` shows where it keeps its data."""

import argparse
import importlib.util
import socket
import subprocess
import sys
import threading
import time
import webbrowser

from . import DIST_NAME, __version__


def _browser_host(host: str) -> str:
    """The host to put in a URL: a wildcard or loopback bind is opened as
    localhost, and an IPv6 literal needs brackets."""
    if host in ("127.0.0.1", "0.0.0.0", "::", "::1", ""):
        return "localhost"
    return f"[{host}]" if ":" in host else host


def _lan_ip() -> str | None:
    """This machine's address on its default route. A UDP connect sends
    nothing, it only picks a route."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return None


_OSRELEASE = "/proc/sys/kernel/osrelease"


def _behind_wsl_nat() -> bool:
    """WSL 2 in its default NAT mode: the VM's address is private to the
    Windows host, so other machines can't reach it (mirrored mode shares
    Windows' addresses; WSL 1 has no VM)."""
    try:
        with open(_OSRELEASE) as f:
            if "wsl2" not in f.read().lower():
                return False
    except OSError:
        return False
    try:
        mode = subprocess.run(
            ["wslinfo", "--networking-mode"],
            capture_output=True,
            text=True,
            timeout=2,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return True  # no wslinfo: older WSL, where NAT is the only mode
    return mode != "mirrored"


def _network_url(host: str, port: int) -> str | None:
    """A URL other machines can open, or None when there's no honest one.
    Only for an IPv4 wildcard bind: `::` is IPv6-only on Windows (and with
    bindv6only on Linux), so an IPv4 address for it may refuse connections."""
    if host != "0.0.0.0" or _behind_wsl_nat():
        return None
    ip = _lan_ip()
    return f"http://{ip}:{port}" if ip else None


def _port_free(host: str, port: int) -> bool:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as s:
        # As uvicorn binds, so a just-stopped Moiré's TIME_WAIT isn't "in use".
        # Not on Windows, where SO_REUSEADDR lets a bind steal a live port.
        if sys.platform != "win32":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def _run(args: argparse.Namespace) -> None:
    import uvicorn

    from .core.config import MOIRE_HOME
    from .web_ui import WEB_DIR

    url = f"http://{_browser_host(args.host)}:{args.port}"
    # Checked up front: the app's startup (DB, watchers) runs before uvicorn
    # binds, and a failed bind then hangs on shutdown instead of exiting.
    if not _port_free(args.host, args.port):
        sys.exit(
            f"Port {args.port} is already in use (is Moiré already running? "
            f"{url}). Pick another with --port."
        )
    print(f"Moiré {__version__}, data in {MOIRE_HOME}")
    if not (WEB_DIR / "index.html").is_file():
        print("  No built UI in this install: only the API is served (pnpm build).")
    if importlib.util.find_spec("onnxruntime") is None:
        print(
            "  AI tagging is off: onnxruntime isn't installed. Reinstall with\n"
            f'  `uv tool install "{DIST_NAME}[cpu]"` (or [gpu] for an NVIDIA GPU).'
        )
    print(f"  Open {url}  (Ctrl+C to stop)")
    if network_url := _network_url(args.host, args.port):
        print(f"  On your network: {network_url}")
    # Before uvicorn's logs (stderr), also when stdout is a pipe.
    sys.stdout.flush()
    log_level = "info" if args.verbose else "warning"
    if args.reload:  # dev: uvicorn's reloader owns the server process
        try:
            uvicorn.run(
                "moire.main:app",
                host=args.host,
                port=args.port,
                reload=True,
                log_level=log_level,
            )
        except KeyboardInterrupt:
            pass
        print("Moiré stopped.")
        return

    server = uvicorn.Server(
        uvicorn.Config(
            "moire.main:app", host=args.host, port=args.port, log_level=log_level
        )
    )
    if args.open:
        # Only once the port is ours: if binding fails (port in use), opening
        # the URL would show whatever else is listening there.
        def open_when_started() -> None:
            for _ in range(600):
                if server.started:
                    webbrowser.open(url)
                    return
                time.sleep(0.1)

        threading.Thread(target=open_when_started, daemon=True).start()
    # uvicorn finishes its graceful shutdown on the first Ctrl+C, but asyncio
    # (or a second Ctrl+C mid-shutdown) can still surface KeyboardInterrupt
    # here; that is a normal exit, not a traceback.
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    print("Moiré stopped.")


def _paths(_: argparse.Namespace) -> None:
    from .core.config import MOIRE_HOME, settings
    from .web_ui import WEB_DIR

    rows = [
        ("home (MOIRE_HOME)", MOIRE_HOME),
        ("settings (.env)", MOIRE_HOME / ".env"),
        ("database", settings.sqlite_file),
        ("thumbnails", settings.thumb_root_path),
        ("tagger models", settings.model_cache_dir_path),
        ("logs", settings.log_dir_path),
        ("ui", WEB_DIR),
    ]
    width = max(len(name) for name, _ in rows)
    for name, path in rows:
        print(f"{name:<{width}}  {path}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="moire",
        description="Moiré: a local gallery for organizing, tagging and generating AI images.",
    )
    parser.add_argument("--version", action="version", version=f"moire {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    run = sub.add_parser("run", help="start Moiré (API and UI on one port)")
    run.add_argument(
        "--host",
        default="127.0.0.1",
        help="interface to bind (default: 127.0.0.1; 0.0.0.0 for your LAN)",
    )
    run.add_argument("--port", type=int, default=8000, help="port (default: 8000)")
    run.add_argument("--open", action="store_true", help="open Moiré in your browser")
    run.add_argument(
        "--reload", action="store_true", help="restart on code changes (development)"
    )
    run.add_argument("-v", "--verbose", action="store_true", help="log every request")
    run.set_defaults(func=_run)

    paths = sub.add_parser("paths", help="show where Moiré keeps its data")
    paths.set_defaults(func=_paths)

    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        sys.exit(2)
    args.func(args)


if __name__ == "__main__":
    main()
