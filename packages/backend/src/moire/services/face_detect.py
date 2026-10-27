"""Finding the face in a character's avatar, so it can be cropped to it.

The detector is a small YOLOv8 face model trained on anime art
(``deepghs/anime_face_detection``, MIT), shipped as ONNX so it runs on the
onnxruntime the tagger already uses: about 12 MB and 0.15 s an image on CPU.
It is optional. Nothing downloads until the user asks (Settings > Characters);
without it avatars keep their default framing.

It runs only on avatar images (a character's cover), in a background worker
off the event loop (:mod:`face_worker`), and keeps what it found in ``image_faces``: one row per
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

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import ai_settings, storage_fs
from .ai_tagger import resolved_model_target
from .ai_tagger_download import RemoteFile, get_download_manager, hf_url

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


async def model_cache_dir() -> str:
    return resolved_model_target(await ai_settings.get_ai_settings())[1]


def downloaded(cache_dir: str) -> bool:
    return all(os.path.exists(f.dst_path) for f in files(cache_dir))


async def ready() -> bool:
    """Whether faces are being found: switched on and the model on disk."""
    s = await ai_settings.get_ai_settings()
    return bool(s.get("face_detect")) and downloaded(await model_cache_dir())


async def start_download():
    """Fetch the model in the background; once it is on disk every avatar is
    queued (``face_worker``)."""
    from .face_worker import get_face_worker  # imports this module

    folder = await model_cache_dir()
    st = await get_download_manager().start(
        model_repo=MODEL,
        cache_dir=folder,
        files=files(folder),
        kind="face_download",
        on_done=get_face_worker().queue_avatars,
    )
    if st.status == "done":
        # Already on disk: no download ran to say so.
        get_face_worker().start_avatars()
    return st


async def cancel_download() -> bool:
    return await get_download_manager().cancel(
        model_repo=MODEL, cache_dir=await model_cache_dir()
    )


async def status() -> dict[str, Any]:
    """Switched on, downloaded, the download's progress and how many images
    wait. Only reads: avatars are queued by ``face_worker``."""
    from .face_worker import get_face_worker  # imports this module

    s = await ai_settings.get_ai_settings()
    cache_dir = resolved_model_target(s)[1]
    dl = get_download_manager().get_state(model_repo=MODEL, cache_dir=cache_dir)
    return {
        "model": MODEL,
        "enabled": bool(s.get("face_detect")),
        "downloaded": downloaded(cache_dir),
        "download": dl.as_dict(),
        "pending": get_face_worker().pending,
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


# --- What was found -------------------------------------------------------------


def _current():
    """Face rows still true of their image: this model, this file."""
    f, im = t.image_faces, t.images
    return f.join(
        im,
        sa.and_(
            im.c._id == f.c.image_id,
            f.c.model == MODEL,
            sa.or_(
                im.c.mtime == f.c.mtime,
                sa.and_(im.c.mtime.is_(None), f.c.mtime.is_(None)),
            ),
        ),
    )


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
                sa.select(f.c.image_id, f.c.cx, f.c.cy, f.c.w, f.c.h)
                .select_from(_current())
                .where(f.c.image_id.in_(ids), f.c.conf.isnot(None))
            )
        ).fetchall()
    return {r.image_id: (r.cx, r.cy, r.w, r.h) for r in rows}


async def unchecked(image_ids: list[str]) -> list[str]:
    f = t.image_faces
    async with async_conn() as conn:
        done = set(
            (
                await conn.execute(
                    sa.select(f.c.image_id)
                    .select_from(_current())
                    .where(f.c.image_id.in_(image_ids))
                )
            ).scalars()
        )
    return [i for i in image_ids if i not in done]


async def detect_now(image_id: str) -> None:
    """Look at one image before answering (a newly pinned avatar). Never
    fails the caller: a failure is logged and stored as no face."""
    if await ready() and await unchecked([image_id]):
        await detect_and_store(image_id, await model_cache_dir())


async def detect_and_store(image_id: str, cache_dir: str) -> None:
    """Look at one image and remember the answer. An image that can't be
    read, or makes the model fail, is remembered as having no face, so it
    isn't tried again until its file changes."""
    async with async_conn() as conn:
        row = (
            await conn.execute(
                sa.select(t.images.c.thumb_key, t.images.c.mtime).where(
                    t.images.c._id == image_id
                )
            )
        ).first()
    if row is None:
        return
    path = storage_fs.thumb_path(row.thumb_key) if row.thumb_key else None
    face = None
    if path is not None:
        try:
            face = await asyncio.to_thread(detect, str(path), cache_dir)
        except Exception:
            logger.exception("Face detection failed for %s", image_id)
    values = {
        **dict(zip(("cx", "cy", "w", "h", "conf"), face or (None,) * 5)),
        "model": MODEL,
        "mtime": row.mtime,
    }
    async with async_tx() as conn:
        stmt = sqlite_insert(t.image_faces).values(image_id=image_id, **values)
        await conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[t.image_faces.c.image_id], set_=values
            )
        )


def download_state(cache_dir: str) -> dict[str, Any]:
    """The face model's download, for the model cache at ``cache_dir``."""
    return (
        get_download_manager()
        .get_state(model_repo=MODEL, cache_dir=cache_dir)
        .as_dict()
    )
