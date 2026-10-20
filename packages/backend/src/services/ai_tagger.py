from __future__ import annotations

import asyncio
import logging
import csv
import time
from dataclasses import dataclass
from io import BytesIO
from typing import Any

import numpy as np
from PIL import Image

try:
    import onnxruntime as rt
except Exception:  # pragma: no cover
    rt = None  # type: ignore[assignment]

from ..core.config import settings as app_settings
from .ai_tagger_download import (
    download_wd_tagger,
    get_download_manager,
    model_target,
)

logger = logging.getLogger("moire.ai_tagger")


def mcut_threshold(probs: np.ndarray) -> float:
    """Compute the MCUT threshold.

    MCUT finds the biggest drop between sorted probabilities and returns the
    midpoint between the two values around that drop.

    This must handle edge cases where the category has 0 or 1 probability.
    """
    if probs is None:
        return 0.0
    if len(probs) < 2:
        return float(probs[0]) if len(probs) == 1 else 0.0
    sorted_probs = probs[probs.argsort()[::-1]]
    difs = sorted_probs[:-1] - sorted_probs[1:]
    t = int(difs.argmax())
    return float((sorted_probs[t] + sorted_probs[t + 1]) / 2)


@dataclass(frozen=True)
class LabelIndex:
    names: list[str]
    rating_idx: np.ndarray
    general_idx: np.ndarray
    character_idx: np.ndarray


def _load_labels_from_csv(csv_path: str) -> LabelIndex:
    names: list[str] = []
    categories: list[int] = []

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("name") or "").strip()
            cat_str = (row.get("category") or "").strip()
            if not name or not cat_str:
                continue
            try:
                cat = int(cat_str)
            except Exception:
                continue

            # Stored as the model spells it: underscores are the canonical
            # tag form (services/tag_names.py); the UI shows them as spaces.
            names.append(name)
            categories.append(cat)

    cats = np.asarray(categories)
    rating_idx = np.where(cats == 9)[0]
    general_idx = np.where(cats == 0)[0]
    character_idx = np.where(cats == 4)[0]

    return LabelIndex(
        names=names,
        rating_idx=rating_idx,
        general_idx=general_idx,
        character_idx=character_idx,
    )


def select_tags(
    labels: LabelIndex,
    preds: np.ndarray,
    *,
    general_thresh: float,
    character_thresh: float,
    general_mcut: bool = False,
    character_mcut: bool = False,
    max_general: int = 80,
    max_character: int = 40,
) -> dict[str, Any]:
    """Turn raw model probabilities into rating + thresholded tag lists.

    Pure post-processing (threshold, optional MCUT, sort, cap) split out of the
    ONNX session so the tagging logic can be unit-tested with a fake ``preds``
    array and a small :class:`LabelIndex`, no onnxruntime required.
    """
    probs = preds.astype(float)

    rating = {labels.names[i]: float(probs[i]) for i in labels.rating_idx}

    def pick(idx: np.ndarray, thresh: float, cap: int) -> list[tuple[str, float]]:
        # Masks over the label indexes, so only the kept handful of the ~10k
        # labels become Python tuples. Stable sort: ties keep label order.
        keep = idx[probs[idx] > thresh]
        keep = keep[np.argsort(-probs[keep], kind="stable")]
        if cap > 0:
            keep = keep[: int(cap)]
        return [(labels.names[i], float(probs[i])) for i in keep]

    if general_mcut and len(labels.general_idx):
        general_thresh = mcut_threshold(probs[labels.general_idx])
    general = pick(labels.general_idx, general_thresh, max_general)

    if character_mcut and len(labels.character_idx):
        character_thresh = max(0.15, mcut_threshold(probs[labels.character_idx]))
    character = pick(labels.character_idx, character_thresh, max_character)

    caption = ", ".join([t for t, _ in general])

    return {
        "caption": caption,
        "rating": rating,
        "general_tags": general,
        "character_tags": character,
    }


def decode_image(image_bytes: bytes) -> Image.Image:
    """Decode to RGBA (forces the full load). Blocking: call from a thread."""
    return Image.open(BytesIO(image_bytes)).convert("RGBA")


def prepare_image(img: Image.Image, target_size: int | None) -> np.ndarray:
    """The model's input tensor: alpha flattened onto white, padded square
    with white, resized to ``target_size``, BGR float32. Pads before resizing,
    as the reference WD tagger code does: resizing first shifts the picture by
    a fraction of a pixel, which measurably moved borderline tags (one rating
    in 30 flipped). Blocking: call from a thread."""
    canvas = Image.new("RGBA", img.size, (255, 255, 255, 255))
    canvas.alpha_composite(img if img.mode == "RGBA" else img.convert("RGBA"))
    img = canvas.convert("RGB")

    w, h = img.size
    m = max(w, h)
    pad = Image.new("RGB", (m, m), (255, 255, 255))
    pad.paste(img, ((m - w) // 2, (m - h) // 2))

    target = target_size if target_size is not None else m
    if m != target:
        pad = pad.resize((int(target), int(target)), Image.Resampling.BICUBIC)

    arr = np.asarray(pad, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR
    return arr[None, ...]


@dataclass(frozen=True)
class PreparedImage:
    """A decoded image and, when the model's input size was known at load
    time, its input tensor. Lets the job worker's prefetch do the resize
    off the inference path; the tagger re-prepares from ``image`` when the
    tensor is missing or was made for another model's size."""

    image: Image.Image
    tensor: np.ndarray | None = None


class WDTagger:
    def __init__(self) -> None:
        self._session: Any | None = None
        self._labels: LabelIndex | None = None
        self._target_size: int | None = None
        self._repo: str | None = None

    @property
    def repo(self) -> str | None:
        return self._repo

    @property
    def loaded(self) -> bool:
        return self._session is not None

    def unload(self) -> None:
        # Best-effort: drop references so Python can GC.
        self._session = None
        self._labels = None
        self._target_size = None
        self._repo = None

    async def load(self, model_repo: str, *, cache_dir: str) -> None:
        if rt is None:
            raise RuntimeError(
                "onnxruntime is not installed. Add it to backend dependencies."
            )

        if self._repo == model_repo and self._session is not None:
            return

        csv_path, onnx_path = await download_wd_tagger(model_repo, cache_dir=cache_dir)
        labels = await asyncio.to_thread(_load_labels_from_csv, csv_path)

        # Import locally so type checkers don't treat rt as Optional.
        import onnxruntime as ort

        session = await asyncio.to_thread(_make_session, ort, onnx_path)

        # Input shape is typically (N, H, W, C)
        _, h, _, _ = session.get_inputs()[0].shape
        target_size = int(h) if h is not None else None

        self._session = session
        self._labels = labels
        self._target_size = target_size
        self._repo = model_repo

    @property
    def input_size(self) -> int | None:
        """The model's square input side, once loaded."""
        return self._target_size if self._session is not None else None

    def predict(
        self,
        *,
        image: Image.Image | PreparedImage,
        general_thresh: float,
        character_thresh: float,
        general_mcut: bool = False,
        character_mcut: bool = False,
        max_general: int = 80,
        max_character: int = 40,
    ) -> dict[str, Any]:
        assert self._session is not None and self._labels is not None

        if isinstance(image, PreparedImage):
            tensor = image.tensor
            if tensor is None or tensor.shape[1] != self._target_size:
                tensor = prepare_image(image.image, self._target_size)
        else:
            tensor = prepare_image(image, self._target_size)
        input_tensor = tensor
        input_name = self._session.get_inputs()[0].name
        output_name = self._session.get_outputs()[0].name

        preds = self._session.run([output_name], {input_name: input_tensor})[0][0]

        return select_tags(
            self._labels,
            preds,
            general_thresh=general_thresh,
            character_thresh=character_thresh,
            general_mcut=general_mcut,
            character_mcut=character_mcut,
            max_general=max_general,
            max_character=max_character,
        )


def _warn_if_both_builds() -> None:
    """Both onnxruntime builds share one `onnxruntime/` package dir, so having
    both installed leaves whichever went in last (usually a `uv run` from a
    shell without UV_NO_GROUP=cpu putting the CPU build over the GPU one)."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        version("onnxruntime")
        version("onnxruntime-gpu")
    except PackageNotFoundError:
        return
    logger.warning(
        "Both onnxruntime and onnxruntime-gpu are installed, so tagging may run "
        "on the CPU. Fix: UV_NO_GROUP=cpu uv sync --group gpu "
        "--reinstall-package onnxruntime-gpu"
    )


def _make_session(ort, onnx_path: str):
    """An inference session on the GPU when the optional ``gpu`` dependency
    group is installed (onnxruntime-gpu plus the CUDA 12 pip wheels), else on
    the CPU. CUDA falls back to CPU per op, so a GPU session never fails a run
    a CPU one would pass."""
    _warn_if_both_builds()
    providers = ["CPUExecutionProvider"]
    if "CUDAExecutionProvider" in ort.get_available_providers():
        # The CUDA/cuDNN libraries come from the nvidia-* wheels, which the
        # loader won't find on its own: without this, onnxruntime quietly
        # falls back to the CPU.
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
        providers.insert(0, "CUDAExecutionProvider")
    session = ort.InferenceSession(onnx_path, providers=providers)
    logger.info("Tagger session providers: %s", session.get_providers())
    return session


class TaggerManager:
    """Process-level tagger manager with idle-unload."""

    def __init__(self) -> None:
        self._tagger = WDTagger()
        self._lock = asyncio.Lock()
        self._last_used = 0.0
        self._idle_unload_s = 300
        self._load_task: asyncio.Task | None = None
        self._loading_for: tuple[str, str] | None = None
        self._load_error: str | None = None
        self._load_status: str = "idle"  # idle|loading|loaded|error|cancelled

    def status(self) -> dict[str, Any]:
        return {
            "loaded": self._tagger.loaded,
            "repo": self._tagger.repo,
            "last_used": self._last_used,
            "idle_unload_s": self._idle_unload_s,
        }

    def load_status(self) -> dict[str, Any]:
        repo = self._loading_for[0] if self._loading_for else self._tagger.repo
        cache_dir = self._loading_for[1] if self._loading_for else None
        dl = None
        available = False
        if repo and cache_dir:
            dm = get_download_manager()
            dl = dm.get_state(model_repo=repo, cache_dir=cache_dir).as_dict()
            available = dm.is_available(model_repo=repo, cache_dir=cache_dir)
        return {
            "status": self._load_status,
            "error": self._load_error,
            "loading_for": self._loading_for,
            "download": dl,
            # Whether the model files already exist at the cache location, so a
            # cancelled/failed load can be retried as a fast disk load with no
            # re-download.
            "available": available,
        }

    def start_load(self, *, model_repo: str, cache_dir: str) -> bool:
        # Fire-and-forget background load so UI can poll progress.
        if self._tagger.loaded and self._tagger.repo == model_repo:
            self._load_status = "loaded"
            self._load_error = None
            return False

        if self._load_task is not None and not self._load_task.done():
            # A load is already in flight. If it targets exactly this
            # (repo, cache_dir), let it run. Otherwise the target changed, e.g.
            # the user corrected a wrong cache dir, so supersede the stale load
            # and cancel its (possibly large) download instead of refusing to
            # start. The new load's existence check (see ensure_loaded ->
            # download_wd_tagger -> ModelDownloadManager.start) then loads from
            # disk with no download if the model is already present there.
            if self._loading_for == (model_repo, cache_dir):
                return False
            if self._loading_for is not None:
                prev_repo, prev_cache = self._loading_for
                get_download_manager().cancel_sync(
                    model_repo=prev_repo, cache_dir=prev_cache
                )
            self._load_task.cancel()

        self._loading_for = (model_repo, cache_dir)
        self._load_error = None
        self._load_status = "loading"

        async def _runner() -> None:
            # Status writes are guarded by a task-identity check so a superseded
            # load (cancelled above) can't clobber the status of the load that
            # replaced it when its CancelledError finally unwinds.
            try:
                await self.ensure_loaded(model_repo=model_repo, cache_dir=cache_dir)
                if self._load_task is asyncio.current_task():
                    self._load_status = "loaded"
            except asyncio.CancelledError:
                if self._load_task is asyncio.current_task():
                    self._load_status = "cancelled"
                raise
            except Exception as e:
                logger.exception("Failed to load AI tagger model %s", model_repo)
                if self._load_task is asyncio.current_task():
                    self._load_status = "error"
                    self._load_error = str(e)
            finally:
                # If load succeeded, clear "loading_for".
                if (
                    self._load_task is asyncio.current_task()
                    and self._load_status == "loaded"
                ):
                    self._loading_for = None

        self._load_task = asyncio.create_task(
            _runner(), name=f"model-load:{model_repo}"
        )
        return True

    async def cancel_load(self) -> bool:
        if not self._loading_for:
            return False
        repo, cache_dir = self._loading_for
        # Cancel download (if in progress)
        await get_download_manager().cancel(model_repo=repo, cache_dir=cache_dir)
        # Cancel load task (if running)
        if self._load_task is not None and not self._load_task.done():
            self._load_status = "cancelled"
            self._load_task.cancel()
            return True
        return False

    def set_idle_unload_s(self, seconds: int) -> None:
        self._idle_unload_s = max(0, int(seconds))

    async def ensure_loaded(self, *, model_repo: str, cache_dir: str) -> None:
        while True:
            # If a background load task is already doing this exact work, await it.
            task = self._load_task
            current = asyncio.current_task()
            if (
                task is not None
                and not task.done()
                and self._loading_for == (model_repo, cache_dir)
                and task is not current
            ):
                await task
                if self._tagger.loaded and self._tagger.repo == model_repo:
                    self._last_used = time.time()
                    return
                raise RuntimeError(self._load_error or "model load failed")

            async with self._lock:
                # Re-check under the lock to avoid racing with another loader.
                task2 = self._load_task
                if (
                    task2 is not None
                    and not task2.done()
                    and self._loading_for == (model_repo, cache_dir)
                    and task2 is not asyncio.current_task()
                ):
                    # Another load started while we waited for the lock.
                    continue

                # Already loaded -> just bump last_used.
                if self._tagger.loaded and self._tagger.repo == model_repo:
                    self._last_used = time.time()
                    return

                await self._tagger.load(model_repo, cache_dir=cache_dir)
                self._last_used = time.time()
                return

    async def unload(self) -> None:
        async with self._lock:
            self._tagger.unload()

    def input_size(self) -> int | None:
        """The loaded model's square input side, else None."""
        return self._tagger.input_size

    async def predict_image(
        self,
        *,
        image: Image.Image | PreparedImage,
        model_repo: str,
        cache_dir: str,
        general_thresh: float,
        character_thresh: float,
        general_mcut: bool,
        character_mcut: bool,
        max_general: int,
        max_character: int,
    ) -> dict[str, Any]:
        await self.ensure_loaded(model_repo=model_repo, cache_dir=cache_dir)
        async with self._lock:
            # Lock ensures session use is serialized (safe baseline) and keeps
            # unload() from dropping the session mid-run. Inference runs in a
            # thread (ORT releases the GIL) so a ~1s run doesn't stall the API.
            self._last_used = time.time()
            run = asyncio.ensure_future(
                asyncio.to_thread(
                    self._tagger.predict,
                    image=image,
                    general_thresh=general_thresh,
                    character_thresh=character_thresh,
                    general_mcut=general_mcut,
                    character_mcut=character_mcut,
                    max_general=max_general,
                    max_character=max_character,
                )
            )
            try:
                return await asyncio.shield(run)
            finally:
                # Cancelled mid-run, the thread still uses the session: keep
                # the lock until it ends, or an unload/reload could swap the
                # session out from under it.
                while not run.done():
                    try:
                        await asyncio.wait({run})
                    except asyncio.CancelledError:
                        pass

    async def idle_unload_loop(self, *, poll_s: float = 5.0) -> None:
        while True:
            await asyncio.sleep(max(1.0, float(poll_s)))
            idle_unload_s = int(self._idle_unload_s or 0)
            if idle_unload_s <= 0:
                continue
            st = self.status()
            if not st["loaded"]:
                continue
            last = float(st["last_used"] or 0.0)
            if last and (time.time() - last) > float(idle_unload_s):
                await self.unload()


# Singleton
_tagger_manager: TaggerManager | None = None


def get_tagger_manager() -> TaggerManager:
    global _tagger_manager
    if _tagger_manager is None:
        _tagger_manager = TaggerManager()
    return _tagger_manager


def model_status_view(settings: dict[str, Any]) -> dict[str, Any]:
    """The assembled model status the API serves: live tagger state, load state,
    and the download state for the settings' target. One place stitches the two
    managers together so routes don't reach into either's internals."""
    repo, cache_dir = model_target(settings)
    cache_dir = str(app_settings.resolve_cache_dir(cache_dir))
    mgr = get_tagger_manager()
    return {
        "model": mgr.status(),
        "model_load": mgr.load_status(),
        "model_download": get_download_manager()
        .get_state(model_repo=repo, cache_dir=cache_dir)
        .as_dict(),
    }
