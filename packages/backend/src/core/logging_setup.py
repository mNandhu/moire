"""Process-wide logging: one format on the console, plus a rotating log file.

Before this, the `moire.*` loggers had no handler at all, so records fell
through to Python's last-resort handler — WARNING and above only, unformatted,
stderr only. Errors were visible while a terminal was attached and gone after.

`setup_logging()` is called from the app lifespan (so importing `src.main` in
tests never creates log files) and is idempotent. Uvicorn configures its own
loggers before the app starts; we leave those handlers alone and only add the
file handler to `uvicorn.error`, which is where unhandled request exceptions
("Exception in ASGI application") are reported.
"""

from __future__ import annotations

import logging
import sys
import threading
from logging.handlers import RotatingFileHandler

from .config import settings

LOG_FORMAT = "%(asctime)s %(levelname)-7s [%(name)s] %(message)s"

_configured = False


def _log_thread_exception(args: threading.ExceptHookArgs) -> None:
    # Background threads (scans, reprojection, watchers) otherwise print a bare
    # traceback to stderr that never reaches the log file.
    if args.exc_type is SystemExit:
        return
    name = args.thread.name if args.thread else "?"
    logging.getLogger("moire.thread").error(
        "Unhandled exception in thread %s",
        name,
        exc_info=(args.exc_type, args.exc_value, args.exc_traceback),  # type: ignore[arg-type]
    )


def setup_logging() -> None:
    global _configured
    if _configured:
        return
    _configured = True

    level = logging.getLevelNamesMapping().get(settings.log_level.upper(), logging.INFO)
    formatter = logging.Formatter(LOG_FORMAT)

    root = logging.getLogger()
    root.setLevel(level)
    # Under uvicorn the root logger has no handlers; under another runner that
    # already configured one, don't print every record twice.
    if not root.handlers:
        console = logging.StreamHandler(sys.stderr)
        console.setFormatter(formatter)
        root.addHandler(console)

    file_handler: RotatingFileHandler | None = None
    if settings.log_to_file:
        log_dir = settings.log_dir_path
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            file_handler = RotatingFileHandler(
                log_dir / "moire.log",
                maxBytes=settings.log_file_max_bytes,
                backupCount=settings.log_file_backups,
                encoding="utf-8",
            )
        except OSError as e:
            # A read-only or unmounted log dir (e.g. a container) must not
            # stop the API from starting; the console still gets everything.
            logging.getLogger("moire").warning(
                "File logging disabled: cannot write to %s (%s)", log_dir, e
            )
    if file_handler is not None:
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
        # uvicorn's loggers don't propagate to root; tap the error stream so
        # unhandled request exceptions land in the file too.
        logging.getLogger("uvicorn.error").addHandler(file_handler)

    threading.excepthook = _log_thread_exception
