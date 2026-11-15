"""This suite's bench env: ``benvcore`` with BENCH = ``$BENCH_WORK/combined``."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benvcore import *  # noqa: E402,F401,F403
from benvcore import setup as _setup, work  # noqa: E402

BENCH = work("combined")


def setup(db, thumbs, **extra: str) -> None:
    _setup(BENCH, db, thumbs, **extra)
