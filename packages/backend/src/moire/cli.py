"""The `moire` command: `moire run` starts the app (API and UI on one port),
`moire paths` shows where it keeps its data."""

import argparse
import importlib.util
import socket
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
    log_level = "info" if args.verbose else "warning"
    if args.reload:  # dev: uvicorn's reloader owns the server process
        uvicorn.run(
            "moire.main:app",
            host=args.host,
            port=args.port,
            reload=True,
            log_level=log_level,
        )
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
    server.run()


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
