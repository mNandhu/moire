"""Start a throwaway Moiré for the e2e suite.

Wipes `packages/e2e/.sandbox`, lays out a fixture library in it, then execs
uvicorn with every data path pointed inside the sandbox, so a run never reads
or writes the developer's own DB, thumbnails or models.

Run from the backend env (Playwright's webServer does this):
    uv --directory packages/backend run python ../e2e/servers/start_backend.py
"""

import os
import shutil
import sys
import time
from pathlib import Path

from PIL import Image

E2E = Path(__file__).resolve().parent.parent
REPO = E2E.parent.parent
SANDBOX = E2E / ".sandbox"
HOME = SANDBOX / "home"
IMAGES = SANDBOX / "images"
PORT = os.environ.get("E2E_BACKEND_PORT", "8020")

# More than one feed page (PAGE_LIMIT is 100), so paging is exercised.
FILLER = 120


def lay_out_library() -> None:
    """The six generated SFW images (prompt metadata, one folder per
    character) plus plain filler. Fixed mtimes: the feed is newest first, so
    the real images lead and the filler pages after them."""
    base = time.time() - 86400
    real = sorted((REPO / "test_images").rglob("*.png"))
    if not real:
        sys.exit("test_images/ has no PNGs")
    for i, src in enumerate(real):
        dest = IMAGES / src.relative_to(REPO / "test_images")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        t = base - i * 60
        os.utime(dest, (t, t))
    filler = IMAGES / "filler"
    filler.mkdir(parents=True)
    for i in range(FILLER):
        dest = filler / f"filler_{i:03}.png"
        shade = (i * 37) % 200 + 30
        Image.new("RGB", (96, 128), (shade, 90, 255 - shade)).save(dest)
        t = base - 3600 - i * 60
        os.utime(dest, (t, t))


def main() -> None:
    if not (REPO / "packages/backend/src/moire/web/index.html").is_file():
        sys.exit("No built UI: run `pnpm build` first (the backend serves it).")
    shutil.rmtree(SANDBOX, ignore_errors=True)
    HOME.mkdir(parents=True)
    lay_out_library()
    env = {
        **os.environ,
        "MOIRE_HOME": str(HOME),
        "SQLITE_PATH": str(HOME / "data/moire.db"),
        "THUMB_ROOT": str(HOME / "data/thumbs"),
        # Models are big: reuse a cache across runs when one is given.
        "MODEL_CACHE_DIR": os.environ.get("E2E_MODEL_CACHE_DIR")
        or str(HOME / "models"),
        "WATCH_ENABLED_DEFAULT": "false",
        "LOG_TO_FILE": "false",
    }
    args = [sys.executable, "-m", "uvicorn", "moire.main:app"]
    args += ["--host", "127.0.0.1", "--port", PORT]
    os.execve(sys.executable, args, env)


if __name__ == "__main__":
    main()
