import os
import sys
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_ROOT = Path(__file__).resolve().parents[3]  # packages/backend/
_REPO_ROOT = _BACKEND_ROOT.parent.parent  # project root (in a source checkout)


def _user_data_dir() -> Path:
    """The OS's per-user app data folder, for an installed (not checked-out)
    Moiré."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
        return Path(base) / "Moire"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Moire"
    base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / "moire"


def _home() -> tuple[Path, bool]:
    """Where relative data paths (and `.env`) resolve: `MOIRE_HOME` if set,
    else the repo root in a source checkout (so `pnpm dev` keeps `<repo>/data`),
    else the user data folder. Returns (home, is_checkout)."""
    is_checkout = (_REPO_ROOT / "pnpm-workspace.yaml").is_file()
    if env := os.environ.get("MOIRE_HOME"):
        return Path(env).expanduser().resolve(), is_checkout
    return (_REPO_ROOT if is_checkout else _user_data_dir()), is_checkout


MOIRE_HOME, IS_CHECKOUT = _home()

# Every API route is mounted under this prefix (see main.py). Anything that
# builds a URL into the API (e.g. thumbnail URLs embedded in responses) must use
# it rather than spelling the path.
API_PREFIX = "/api/v1"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(
            (MOIRE_HOME / ".env", _BACKEND_ROOT / ".env")
            if IS_CHECKOUT
            else (MOIRE_HOME / ".env",)
        ),
        extra="ignore",
    )

    # SQLite database file. Relative values resolve against MOIRE_HOME (NOT the
    # process cwd), mirroring `thumb_root`, so the DB lands at `<MOIRE_HOME>/data/moire.db`
    # regardless of where uvicorn is started.
    sqlite_path: str = "./data/moire.db"
    # How long a blocked writer waits for SQLite's file lock before erroring
    # (SQLITE_BUSY). WAL + short scanner transactions keep contention rare.
    sqlite_busy_timeout_ms: int = 5000

    # Local filesystem root for generated thumbnails. Must be a persistent
    # volume, kept outside library trees. Keys are `{library_id}/{image_id}.webp`.
    # A relative value is resolved against MOIRE_HOME (NOT the process cwd),
    # so it lands at `<MOIRE_HOME>/data/thumbs` regardless of where uvicorn is started.
    thumb_root: str = "./data/thumbs"

    scanner_max_workers: int = 0
    # How many libraries may scan concurrently; the rest wait their turn.
    scanner_max_concurrent_scans: int = 2
    scan_progress_update_ms: int = 500

    # Filesystem watcher (near-real-time incremental indexing).
    watch_enabled_default: bool = True
    # Quiet period a changed file must hold its size for before it's read (avoids
    # ingesting a file mid-write from ComfyUI/A1111/etc).
    watch_stability_window_ms: int = 500
    watch_stability_max_attempts: int = 6
    # watchfiles' own debounce: how long a burst of events on one path is
    # coalesced before it's delivered as a single batch.
    watch_debounce_ms: int = 800
    # Backstop full rescan per watched library, in case events are missed
    # (network shares, drives that drop inotify/ReadDirectoryChanges).
    watch_reconcile_interval_s: int = 900

    # Local filesystem directory for downloaded AI tagger model files (ONNX +
    # label CSV). Relative values resolve against MOIRE_HOME, the same as
    # `thumb_root` and `sqlite_path`, so the location doesn't depend on the
    # process working directory.
    model_cache_dir: str = ".cache/moire/models"

    thumb_max_size: int = 768

    log_slow_requests_ms: int = 1000

    # Logging (see core/logging_setup.py). Records go to the console and, when
    # `log_to_file` is on, to a rotating `moire.log` under `log_dir`. A relative
    # `log_dir` resolves against MOIRE_HOME, like `thumb_root`.
    log_level: str = "INFO"
    log_to_file: bool = True
    log_dir: str = "./data/logs"
    log_file_max_bytes: int = 10 * 1024 * 1024
    log_file_backups: int = 5

    rate_limit_enabled: bool = False
    rate_limit_rescan_per_minute: int = 1

    @property
    def model_cache_dir_path(self) -> Path:
        """Absolute model cache directory. Relative `model_cache_dir` anchors to
        MOIRE_HOME so the location doesn't depend on the process working directory."""
        p = Path(self.model_cache_dir)
        return p if p.is_absolute() else (MOIRE_HOME / p)

    def resolve_cache_dir(self, cache_dir: str) -> Path:
        """Resolve an arbitrary cache_dir string (e.g. from UI/DB) the same way
        as `model_cache_dir_path`: relative values anchor to MOIRE_HOME."""
        p = Path(cache_dir)
        return p if p.is_absolute() else (MOIRE_HOME / p)

    @property
    def thumb_root_path(self) -> Path:
        """Absolute thumbnail root. Relative `thumb_root` anchors to
        MOIRE_HOME so the location doesn't depend on the process working directory."""
        p = Path(self.thumb_root)
        return p if p.is_absolute() else (MOIRE_HOME / p)

    @property
    def log_dir_path(self) -> Path:
        """Absolute log directory, anchored to MOIRE_HOME when relative."""
        p = Path(self.log_dir)
        return p if p.is_absolute() else (MOIRE_HOME / p)

    @property
    def sqlite_file(self) -> Path:
        """Absolute SQLite file path. Relative `sqlite_path` anchors to
        MOIRE_HOME so the location doesn't depend on the process working directory."""
        p = Path(self.sqlite_path)
        return p if p.is_absolute() else (MOIRE_HOME / p)


settings = Settings()
