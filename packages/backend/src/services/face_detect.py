"""Finding the face in a character's avatar, so it can be cropped to it.

The detector is a small YOLOv8 face model trained on anime art
(``deepghs/anime_face_detection``, MIT), shipped as ONNX so it runs on the
onnxruntime the tagger already uses: about 12 MB and 0.15 s an image on CPU.
It is optional. Nothing downloads until the user asks (Settings > Characters);
without it avatars keep their default framing.

It runs only on avatar images (a character's cover), in a background worker
off the event loop, and keeps what it found in ``image_faces``: one row per
image, a NULL ``conf`` for "ran, no face". Several faces in one image: the
largest of the confident ones wins; telling which face is the character would
need recognition, so a hand-set centre on the character page is the fix.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from typing import Any

import numpy as np
import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..core.config import settings as app_settings
from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import ai_settings, storage_fs
from .ai_tagger_download import (
    RemoteFile,
    get_download_manager,
    hf_url,
    model_target,
)

logger = logging.getLogger("moire.faces")

REPO = "deepghs/anime_face_detection"
VARIANT = "face_detect_v1.4_n"
MODEL = f"{REPO}:{VARIANT}"
INPUT = 640
# Faces this close to the most confident one compete on size.
NEAR_BEST = 0.6


# --- Model files ---------------------------------------------------------------


def files(cache_dir: str) -> list[RemoteFile]:
    folder = os.path.join(cache_dir, REPO.replace("/", "_"), VARIANT)
    return [
        RemoteFile(name, hf_url(REPO, f"{VARIANT}/{name}"), os.path.join(folder, name))
        for name in ("model.onnx", "threshold.json")
    ]


async def _cache_dir() -> str:
    _, cache_dir = model_target(await ai_settings.get_ai_settings())
    return str(app_settings.resolve_cache_dir(cache_dir))


def downloaded(cache_dir: str) -> bool:
    return all(os.path.exists(f.dst_path) for f in files(cache_dir))


async def ready() -> bool:
    """Whether faces are being found: switched on and the model on disk."""
    s = await ai_settings.get_ai_settings()
    return bool(s.get("face_detect")) and downloaded(await _cache_dir())


async def start_download():
    cache_dir = await _cache_dir()
    st = await get_download_manager().start(
        model_repo=MODEL, cache_dir=cache_dir, files=files(cache_dir)
    )
    return st


async def cancel_download() -> bool:
    return await get_download_manager().cancel(
        model_repo=MODEL, cache_dir=await _cache_dir()
    )


async def status() -> dict[str, Any]:
    cache_dir = await _cache_dir()
    s = await ai_settings.get_ai_settings()
    dl = get_download_manager().get_state(model_repo=MODEL, cache_dir=cache_dir)
    if await ready():
        await _queue_avatars()
    return {
        "model": MODEL,
        "enabled": bool(s.get("face_detect")),
        "downloaded": downloaded(cache_dir),
        "download": dl.as_dict(),
        "pending": len(_pending),
    }


# --- Inference (pure parts first) ---------------------------------------------


def letterbox(w: int, h: int, size: int = INPUT) -> tuple[float, int, int, int, int]:
    """Scale and padding to fit a ``w`` x ``h`` image in a ``size`` square:
    ``(ratio, new_w, new_h, pad_x, pad_y)``. Pure."""
    r = size / max(w, h)
    nw, nh = round(w * r), round(h * r)
    return r, nw, nh, (size - nw) // 2, (size - nh) // 2


def boxes(
    out: np.ndarray, threshold: float, w: int, h: int, size: int = INPUT
) -> list[tuple[float, float, float, float, float]]:
    """Faces from the model's raw output (``(5, N)`` or ``(N, 5)``: centre x,
    centre y, width, height, confidence, in letterbox pixels) as
    ``(cx, cy, bw, bh, conf)`` fractions of the image. Overlapping boxes keep
    the most confident. Pure."""
    rows = out if out.shape[-1] == 5 else out.T
    rows = rows[rows[:, 4] >= threshold]
    r, _, _, px, py = letterbox(w, h, size)
    found: list[tuple[float, float, float, float, float]] = []
    for cx, cy, bw, bh, conf in rows[np.argsort(-rows[:, 4])]:
        face = (
            float((cx - px) / r / w),
            float((cy - py) / r / h),
            float(bw / r / w),
            float(bh / r / h),
            float(conf),
        )
        if all(not _overlaps(face, other) for other in found):
            found.append(face)
    return found


def _overlaps(a, b) -> bool:
    return abs(a[0] - b[0]) < (a[2] + b[2]) / 2 and abs(a[1] - b[1]) < (a[3] + b[3]) / 2


def pick(faces: list[tuple[float, float, float, float, float]]):
    """The avatar's face: the largest of those near the best confidence."""
    if not faces:
        return None
    best = max(f[4] for f in faces)
    return max(
        (f for f in faces if f[4] >= best * NEAR_BEST), key=lambda f: f[2] * f[3]
    )


_session_lock = threading.Lock()
_session: tuple[str, Any, float] | None = None


def _load(cache_dir: str):
    global _session
    model, threshold = files(cache_dir)
    with _session_lock:
        if _session is None or _session[0] != model.dst_path:
            import onnxruntime as ort

            sess = ort.InferenceSession(
                model.dst_path, providers=["CPUExecutionProvider"]
            )
            with open(threshold.dst_path, encoding="utf-8") as f:
                thr = float(json.load(f)["threshold"])
            _session = (model.dst_path, sess, thr)
        return _session[1], _session[2]


def detect(image_path: str, cache_dir: str):
    """The avatar face in an image file, ``(cx, cy, w, h, conf)`` fractions,
    or ``None``. Blocking: run it in a thread."""
    from PIL import Image

    sess, threshold = _load(cache_dir)
    with Image.open(image_path) as img:
        img = img.convert("RGB")
        w, h = img.size
        _, nw, nh, px, py = letterbox(w, h)
        canvas = Image.new("RGB", (INPUT, INPUT), (114, 114, 114))
        canvas.paste(img.resize((nw, nh), Image.Resampling.BILINEAR), (px, py))
    x = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    return pick(boxes(out, threshold, w, h))


# --- The worker ----------------------------------------------------------------

_pending: set[str] = set()
_worker: asyncio.Task | None = None


async def faces_for(
    image_ids: list[str],
) -> dict[str, tuple[float, float, float, float]]:
    """The faces already found for ``image_ids`` (none for no face)."""
    ids = [i for i in image_ids if i]
    if not ids:
        return {}
    f = t.image_faces
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(f.c.image_id, f.c.cx, f.c.cy, f.c.w, f.c.h).where(
                    f.c.image_id.in_(ids), f.c.conf.isnot(None), f.c.model == MODEL
                )
            )
        ).fetchall()
    return {r.image_id: (r.cx, r.cy, r.w, r.h) for r in rows}


async def _unchecked(image_ids: list[str]) -> list[str]:
    f = t.image_faces
    async with async_conn() as conn:
        done = set(
            (
                await conn.execute(
                    sa.select(f.c.image_id).where(
                        f.c.image_id.in_(image_ids), f.c.model == MODEL
                    )
                )
            ).scalars()
        )
    return [i for i in image_ids if i not in done]


async def queue(image_ids: list[str]) -> None:
    """Find faces in these images in the background, skipping ones already
    looked at. Does nothing while detection is off or not downloaded."""
    global _worker
    ids = [i for i in dict.fromkeys(image_ids) if i and i not in _pending]
    if not ids or not await ready():
        return
    _pending.update(await _unchecked(ids))
    if _pending and (_worker is None or _worker.done()):
        _worker = asyncio.create_task(_drain(), name="face-detect")


async def detect_now(image_id: str) -> None:
    """Look at one image before answering (a newly pinned avatar)."""
    if await ready() and await _unchecked([image_id]):
        await _detect_and_store(image_id, await _cache_dir())


async def _drain() -> None:
    cache_dir = await _cache_dir()
    while _pending:
        image_id = next(iter(_pending))
        try:
            await _detect_and_store(image_id, cache_dir)
        except Exception:
            logger.exception("Face detection failed for %s", image_id)
        finally:
            _pending.discard(image_id)  # counted as pending until stored


_avatars_queued = False


async def _queue_avatars() -> None:
    """Once per run, once the model is ready: every current avatar, so they
    are cropped before anyone opens a character."""
    global _avatars_queued
    if _avatars_queued:
        return
    _avatars_queued = True
    from . import characters  # imports this module

    await characters.listing()  # queues each avatar not looked at yet


async def _detect_and_store(image_id: str, cache_dir: str) -> None:
    async with async_conn() as conn:
        key = (
            await conn.execute(
                sa.select(t.images.c.thumb_key).where(t.images.c._id == image_id)
            )
        ).scalar()
    path = storage_fs.thumb_path(key) if key else None
    if path is None:
        return
    face = await asyncio.to_thread(detect, str(path), cache_dir)
    values = dict(zip(("cx", "cy", "w", "h", "conf"), face or (None,) * 5))
    async with async_tx() as conn:
        stmt = sqlite_insert(t.image_faces).values(
            image_id=image_id, model=MODEL, **values
        )
        await conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[t.image_faces.c.image_id],
                set_={**values, "model": MODEL},
            )
        )


async def idle() -> None:
    """Wait for the worker to finish (tests)."""
    if _worker is not None:
        await _worker
