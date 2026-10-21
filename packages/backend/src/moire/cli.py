"""The `moire` command: `moire run` starts the app (API and UI on one port),
`moire paths` shows where it keeps its data."""

import argparse
import importlib.util
import sys
import threading
import webbrowser

from . import DIST_NAME, __version__


def _run(args: argparse.Namespace) -> None:
    import uvicorn

    from .core.config import MOIRE_HOME
    from .web_ui import WEB_DIR

    shown_host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    url = f"http://{shown_host}:{args.port}"
    print(f"Moiré {__version__}, data in {MOIRE_HOME}")
    if not (WEB_DIR / "index.html").is_file():
        print("  No built UI in this install: only the API is served (pnpm build).")
    if importlib.util.find_spec("onnxruntime") is None:
        print(
            "  AI tagging is off: onnxruntime isn't installed. Reinstall with\n"
            f'  `uv tool install "{DIST_NAME}[cpu]"` (or [gpu] for an NVIDIA GPU).'
        )
    print(f"  Open {url}  (Ctrl+C to stop)")
    if args.open:
        # After uvicorn has had a moment to bind; a browser that loads early
        # just retries.
        threading.Timer(1.5, webbrowser.open, (url,)).start()

    uvicorn.run(
        "moire.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="warning" if not args.verbose else "info",
    )


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
