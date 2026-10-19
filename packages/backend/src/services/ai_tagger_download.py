"""Tagger model download: fetching the WD ONNX model + label CSV from HuggingFace.

Split out of ``ai_tagger`` so the model-acquisition concern (httpx streaming,
atomic renames, per-file progress, cancellation) is isolated from inference and
lifecycle. This module depends on nothing else in the project, so importing the
pure inference helpers (``select_tags``) no longer drags in the downloader, and
the download state machine can be reasoned about on its own.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger("moire.ai_download")

# The default model cache location. Lives here (the dependency-free module) so
# both ai_settings and the API can share one source of truth without importing
# ai_tagger (which would create a cycle).
DEFAULT_CACHE_DIR = ".cache/moire/models"


def model_target(settings: dict[str, Any]) -> tuple[str, str]:
    """Resolve ``(model_repo, cache_dir)`` from a settings dict, applying the
    default cache dir. The single place the cache-dir fallback is spelled."""
    repo = str(settings.get("model_repo") or "")
    cache_dir = str(settings.get("cache_dir") or DEFAULT_CACHE_DIR)
    return repo, cache_dir


@dataclass(frozen=True)
class RemoteFile:
    """One file of a model download: its display name, URL and local path."""

    name: str
    url: str
    dst_path: str


def hf_url(repo: str, path: str) -> str:
    """The download URL of ``path`` in a HuggingFace repo (``HF_ENDPOINT``
    honoured)."""
    return f"{_get_hf_endpoint()}/{repo}/resolve/main/{path}"


def _get_hf_endpoint() -> str:
    hf_endpoint = os.getenv("HF_ENDPOINT", "https://huggingface.co")
    if not hf_endpoint.startswith("https://"):
        hf_endpoint = f"https://{hf_endpoint}"
    return hf_endpoint.rstrip("/")


async def _download_if_missing(url: str, dst_path: str) -> None:
    # Back-compat helper: keep simple behavior for any other callers.
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    if os.path.exists(dst_path):
        return

    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            with open(dst_path, "wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=1024 * 256):
                    if chunk:
                        f.write(chunk)


@dataclass
class DownloadFileState:
    name: str
    url: str
    dst_path: str
    status: str = "pending"  # pending|downloading|done|error|cancelled
    downloaded: int = 0
    total: int | None = None
    error: str | None = None


@dataclass
class ModelDownloadState:
    model_repo: str
    cache_dir: str
    status: str = "idle"  # idle|downloading|done|error|cancelled
    started_at: float | None = None
    updated_at: float | None = None
    cancel_requested: bool = False
    error: str | None = None
    files: list[DownloadFileState] = field(default_factory=list)
    # What to fetch; the tagger's own pair when not given.
    spec: tuple[RemoteFile, ...] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "model_repo": self.model_repo,
            "cache_dir": self.cache_dir,
            "status": self.status,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "cancel_requested": self.cancel_requested,
            "error": self.error,
            "files": [
                {
                    "name": f.name,
                    "status": f.status,
                    "downloaded": f.downloaded,
                    "total": f.total,
                    "error": f.error,
                }
                for f in self.files
            ],
        }


class ModelDownloadManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._states: dict[tuple[str, str], ModelDownloadState] = {}
        self._tasks: dict[tuple[str, str], asyncio.Task] = {}

    def get_state(self, *, model_repo: str, cache_dir: str) -> ModelDownloadState:
        key = (model_repo, cache_dir)
        st = self._states.get(key)
        if st is None:
            st = ModelDownloadState(model_repo=model_repo, cache_dir=cache_dir)
            self._states[key] = st
        return st

    async def start(
        self,
        *,
        model_repo: str,
        cache_dir: str,
        files: list[RemoteFile] | None = None,
    ) -> ModelDownloadState:
        """Fetch a model's files in the background. ``files`` names them for a
        model other than the tagger, ``model_repo`` then being any key unique
        to that model (repo plus variant)."""
        key = (model_repo, cache_dir)
        async with self._lock:
            st = self.get_state(model_repo=model_repo, cache_dir=cache_dir)
            if files is not None:
                st.spec = tuple(files)

            # If everything is already there, declare success.
            if all(os.path.exists(f.dst_path) for f in self._spec(st)):
                st.status = "done"
                st.updated_at = time.time()
                return st

            task = self._tasks.get(key)
            if task is not None and not task.done():
                return st

            st.status = "downloading"
            st.started_at = st.started_at or time.time()
            st.updated_at = time.time()
            st.cancel_requested = False
            st.error = None

            async def _runner() -> None:
                try:
                    await self._download_all(st)
                    if st.cancel_requested:
                        st.status = "cancelled"
                    else:
                        st.status = "done"
                except asyncio.CancelledError:
                    st.status = "cancelled"
                    st.cancel_requested = True
                    raise
                except Exception as e:
                    logger.exception("Model download failed for %s", model_repo)
                    st.status = "error"
                    st.error = str(e)
                finally:
                    st.updated_at = time.time()

            self._tasks[key] = asyncio.create_task(
                _runner(), name=f"model-download:{model_repo}"
            )
            return st

    async def cancel(self, *, model_repo: str, cache_dir: str) -> bool:
        key = (model_repo, cache_dir)
        async with self._lock:
            st = self._states.get(key)
            if st is None:
                return False
            st.cancel_requested = True
            st.updated_at = time.time()
            t = self._tasks.get(key)
            if t is not None and not t.done():
                t.cancel()
                return True
            return False

    def cancel_sync(self, *, model_repo: str, cache_dir: str) -> bool:
        """Best-effort cancel callable from sync code (e.g. ``start_load``).

        Skips the async lock, used to supersede a stale download when the load
        target changes, where we can't await. Same task runs on this event loop,
        so ``task.cancel()`` is honoured on the next tick."""
        key = (model_repo, cache_dir)
        st = self._states.get(key)
        if st is not None:
            st.cancel_requested = True
            st.updated_at = time.time()
        t = self._tasks.get(key)
        if t is not None and not t.done():
            t.cancel()
            return True
        return False

    def is_available(self, *, model_repo: str, cache_dir: str) -> bool:
        """Whether both model files already exist at the expected cache paths."""
        csv_path, onnx_path = _expected_paths(
            model_repo=model_repo, cache_dir=cache_dir
        )
        return os.path.exists(csv_path) and os.path.exists(onnx_path)

    async def wait(self, *, model_repo: str, cache_dir: str) -> None:
        key = (model_repo, cache_dir)
        t = self._tasks.get(key)
        if t is not None:
            await t

    @staticmethod
    def _spec(st: ModelDownloadState) -> tuple[RemoteFile, ...]:
        if st.spec is not None:
            return st.spec
        csv_path, onnx_path = _expected_paths(
            model_repo=st.model_repo, cache_dir=st.cache_dir
        )
        return (
            RemoteFile("model.onnx", hf_url(st.model_repo, "model.onnx"), onnx_path),
            RemoteFile(
                "selected_tags.csv",
                hf_url(st.model_repo, "selected_tags.csv"),
                csv_path,
            ),
        )

    async def _download_all(self, st: ModelDownloadState) -> None:
        files = [
            DownloadFileState(name=f.name, url=f.url, dst_path=f.dst_path)
            for f in self._spec(st)
        ]
        st.files = files

        for f in files:
            if st.cancel_requested:
                f.status = "cancelled"
                continue
            if os.path.exists(f.dst_path):
                f.status = "done"
                f.downloaded = os.path.getsize(f.dst_path)
                f.total = f.downloaded
                st.updated_at = time.time()
                continue
            await self._download_one(st, f)

    async def _download_one(self, st: ModelDownloadState, f: DownloadFileState) -> None:
        os.makedirs(os.path.dirname(f.dst_path), exist_ok=True)
        tmp_path = f.dst_path + ".part"

        # Always restart partials to keep logic simple.
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            # Best-effort: partial may be locked/removed concurrently.
            pass

        f.status = "downloading"
        f.downloaded = 0
        f.total = None
        f.error = None
        st.updated_at = time.time()

        try:
            async with httpx.AsyncClient(timeout=None, follow_redirects=True) as client:
                async with client.stream("GET", f.url) as r:
                    r.raise_for_status()
                    try:
                        cl = r.headers.get("Content-Length")
                        f.total = int(cl) if cl else None
                    except Exception:
                        f.total = None

                    with open(tmp_path, "wb") as out:
                        async for chunk in r.aiter_bytes(chunk_size=1024 * 256):
                            if st.cancel_requested:
                                raise asyncio.CancelledError()
                            if not chunk:
                                continue
                            out.write(chunk)
                            f.downloaded += len(chunk)
                            st.updated_at = time.time()

            # Atomic replace
            os.replace(tmp_path, f.dst_path)
            f.status = "done"
            if f.total is None:
                try:
                    f.total = os.path.getsize(f.dst_path)
                except Exception:
                    # Best-effort: filesystem stat may fail on some platforms.
                    pass
        except asyncio.CancelledError:
            f.status = "cancelled"
            raise
        except Exception as e:
            f.status = "error"
            f.error = str(e)
            raise
        finally:
            # Cleanup partial
            if f.status in ("cancelled", "error"):
                try:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    # Best-effort: cleanup failure shouldn't crash the download task.
                    pass


_download_manager: ModelDownloadManager | None = None


def get_download_manager() -> ModelDownloadManager:
    global _download_manager
    if _download_manager is None:
        _download_manager = ModelDownloadManager()
    return _download_manager


def _expected_paths(*, model_repo: str, cache_dir: str) -> tuple[str, str]:
    safe_name = model_repo.replace("/", "_")
    onnx_path = os.path.join(cache_dir, f"{safe_name}.onnx")
    csv_path = os.path.join(cache_dir, f"{safe_name}.csv")
    return csv_path, onnx_path


def labels_csv_path(*, model_repo: str, cache_dir: str) -> str:
    """Where the model's word list (``selected_tags.csv``) is kept."""
    return _expected_paths(model_repo=model_repo, cache_dir=cache_dir)[0]


async def download_wd_tagger(model_repo: str, *, cache_dir: str) -> tuple[str, str]:
    """Download (or reuse cached) wd-tagger model + labels.

    Returns (csv_path, onnx_path)
    """
    model_repo = model_repo.strip()
    if not model_repo or "/" not in model_repo:
        raise ValueError("model_repo must look like 'org/repo'")

    dm = get_download_manager()
    await dm.start(model_repo=model_repo, cache_dir=cache_dir)
    # Wait for completion; cancellation is supported via dm.cancel().
    await dm.wait(model_repo=model_repo, cache_dir=cache_dir)

    csv_path, onnx_path = _expected_paths(model_repo=model_repo, cache_dir=cache_dir)
    return csv_path, onnx_path
