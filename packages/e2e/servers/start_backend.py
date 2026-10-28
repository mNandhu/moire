"""Start a throwaway Moiré for the e2e suite.

Wipes `packages/e2e/.sandbox`, lays out a fixture library in it, then execs
uvicorn with every data path pointed inside the sandbox, so a run never reads
or writes the developer's own DB, thumbnails or models.

Run from the backend env (Playwright's webServer does this):
    uv --directory packages/backend run python ../e2e/servers/start_backend.py
"""

import json
import os
import shutil
import sys
import time
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

E2E = Path(__file__).resolve().parent.parent
REPO = E2E.parent.parent
SANDBOX = E2E / ".sandbox"
HOME = SANDBOX / "home"
IMAGES = SANDBOX / "images"
PORT = os.environ.get("E2E_BACKEND_PORT", "8020")

# More than one feed page (PAGE_LIMIT is 100), so paging is exercised.
FILLER = 120

# An A1111-style prompt with known weights, for the viewer specs.
WEIGHTED = (
    "1girl, solo, (red_scarf:1.3), [blurry], smile, snow\n"
    "Negative prompt: lowres\n"
    "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234, Size: 96x128, Model: e2e_model"
)


def lay_out_library() -> int:
    """The six generated SFW images (prompt metadata, one folder per
    character; furina_63 keeps a prompt escaped twice, as an edge case) plus
    plain filler. Fixed mtimes: the feed is newest first, so
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
    weighted = IMAGES / "weighted" / "weighted.png"
    weighted.parent.mkdir(parents=True)
    info = PngInfo()
    info.add_text("parameters", WEIGHTED)
    Image.new("RGB", (96, 128), (200, 60, 60)).save(weighted, pnginfo=info)
    t = base - 1800
    os.utime(weighted, (t, t))
    filler = IMAGES / "filler"
    filler.mkdir(parents=True)
    for i in range(FILLER):
        dest = filler / f"filler_{i:03}.png"
        shade = (i * 37) % 200 + 30
        Image.new("RGB", (96, 128), (shade, 90, 255 - shade)).save(dest)
        t = base - 3600 - i * 60
        os.utime(dest, (t, t))
    return len(real) + 1 + FILLER


def model_cache() -> Path:
    """The tagger model is big (~360 MB): kept between runs, outside the
    wiped sandbox. Never the checkout's own cache, which `pnpm dev` may be
    using; a model already there is copied over once instead of downloaded."""
    cache = Path(os.environ.get("E2E_MODEL_CACHE_DIR") or E2E / ".models")
    cache.mkdir(parents=True, exist_ok=True)
    dev = REPO / ".cache/moire/models"
    for src in dev.glob("*_wd-*"):
        dest = cache / src.name
        if src.is_file() and not dest.exists():
            part = dest.with_name(f".{dest.name}.part")
            shutil.copyfile(src, part)
            os.replace(part, dest)
    return cache


def main() -> None:
    if not (REPO / "packages/backend/src/moire/web/index.html").is_file():
        sys.exit("No built UI: run `pnpm build` first (the backend serves it).")
    shutil.rmtree(SANDBOX, ignore_errors=True)
    HOME.mkdir(parents=True)
    # The specs read what was laid out rather than counting it themselves.
    # Where the fake ComfyUI saves: Generate's output folder in the specs.
    # The config passes the same path to both servers.
    Path(os.environ.get("E2E_COMFY_OUT") or SANDBOX / "comfy-out").mkdir(parents=True)
    manifest = {"images": lay_out_library(), "dir": str(IMAGES)}
    (SANDBOX / "manifest.json").write_text(json.dumps(manifest))
    # An empty dotenv of its own: the checkout's packages/backend/.env would
    # otherwise apply on top (config.py reads it in a checkout).
    (HOME / ".env").touch()
    env = {
        **os.environ,
        "MOIRE_HOME": str(HOME),
        "MOIRE_ENV_FILE": str(HOME / ".env"),
        "SQLITE_PATH": str(HOME / "data/moire.db"),
        "THUMB_ROOT": str(HOME / "data/thumbs"),
        "MODEL_CACHE_DIR": str(model_cache()),
        "WATCH_ENABLED_DEFAULT": "false",
        "LOG_TO_FILE": "false",
    }
    args = [sys.executable, "-m", "uvicorn", "moire.main:app"]
    args += ["--host", "127.0.0.1", "--port", PORT]
    os.execve(sys.executable, args, env)


if __name__ == "__main__":
    main()
