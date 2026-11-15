"""Shared bench environment: where scratch lives and how a bench process points
Moiré at scratch copies. Import it BEFORE importing ``moire``.

Each suite's ``benv.py`` re-exports this with ``BENCH`` set to its own work dir.
Scratch lives under ``$BENCH_WORK/<suite>`` (default ``<repo>/local-setup/bench``,
gitignored). Keep it on a real disk: timings on tmpfs are meaningless.
"""

import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WORK_ROOT = Path(
    os.environ.get("BENCH_WORK") or REPO / "local-setup" / "bench"
).resolve()
LIVE_DATA = (REPO / "data").resolve()


def work(suite: str) -> Path:
    """The suite's scratch dir (created, with a ``results/`` subdir)."""
    d = WORK_ROOT / suite
    (d / "results").mkdir(parents=True, exist_ok=True)
    return d


def guard(*paths) -> None:
    """Refuse to run against anything outside the scratch root (and so never
    against the live ``data/`` folder)."""
    for p in paths:
        p = Path(p).resolve()
        if p.is_relative_to(LIVE_DATA) or not p.is_relative_to(WORK_ROOT):
            raise SystemExit(f"bench: refusing {p}: not under {WORK_ROOT}")


def setup(bench: Path, db, thumbs, models=None, **extra: str) -> None:
    """Point Moiré's settings at a scratch DB and thumbnail root."""
    guard(db, thumbs)
    empty_env = bench / "empty.env"
    empty_env.touch()
    os.environ.update(
        {
            "MOIRE_ENV_FILE": str(empty_env),
            "MOIRE_HOME": str(bench),
            "SQLITE_PATH": str(Path(db).resolve()),
            "THUMB_ROOT": str(Path(thumbs).resolve()),
            "MODEL_CACHE_DIR": str(models or WORK_ROOT / "ai" / "models"),
            "LOG_TO_FILE": "false",
            "UPDATE_CHECK": "false",
            "LOG_SLOW_REQUESTS_MS": "600000",
            **extra,
        }
    )


def evict(paths) -> int:
    """Drop files from the page cache (no root needed) for cold-read runs."""
    n = 0
    for p in paths:
        try:
            fd = os.open(p, os.O_RDONLY)
        except OSError:
            continue
        try:
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            n += 1
        finally:
            os.close(fd)
    return n


def proc_cpu(pid="self") -> float:
    """utime+stime seconds of a process (all threads)."""
    f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    return (int(f[11]) + int(f[12])) / os.sysconf("SC_CLK_TCK")


def proc_mem(pid="self") -> tuple[int, int]:
    """(RSS, peak RSS) in MB."""
    rss = hwm = 0
    for line in open(f"/proc/{pid}/status"):
        if line.startswith("VmRSS:"):
            rss = int(line.split()[1]) // 1024
        elif line.startswith("VmHWM:"):
            hwm = int(line.split()[1]) // 1024
    return rss, hwm


def load_avg() -> list[str]:
    return open("/proc/loadavg").read().split(" ", 3)[:3]
