"""Unit tests for the pure tagger post-processing: MCUT and tag selection.
Previously buried inside WDTagger.predict behind an ONNX session."""

import asyncio
import contextlib
from pathlib import Path

import numpy as np

from src.services.ai_tagger import (
    LabelIndex,
    TaggerManager,
    mcut_threshold,
    select_tags,
)
from src.services.ai_tagger_download import (
    DEFAULT_CACHE_DIR,
    ModelDownloadManager,
    RemoteFile,
    _expected_paths,
    model_target,
)


def test_model_target_applies_default_cache_dir():
    assert model_target({"model_repo": "a/b"}) == ("a/b", DEFAULT_CACHE_DIR)
    assert model_target({"model_repo": "a/b", "cache_dir": "/x"}) == ("a/b", "/x")
    # Missing repo resolves to "" (the display fallback the status route relied on).
    assert model_target({}) == ("", DEFAULT_CACHE_DIR)


def _labels() -> LabelIndex:
    # index: 0=rating safe, 1=rating explicit, 2=g:cat, 3=g:dog, 4=c:alice
    return LabelIndex(
        names=["safe", "explicit", "cat", "dog", "alice"],
        rating_idx=np.array([0, 1]),
        general_idx=np.array([2, 3]),
        character_idx=np.array([4]),
    )


def test_mcut_edge_cases():
    assert mcut_threshold(None) == 0.0
    assert mcut_threshold(np.array([])) == 0.0
    assert mcut_threshold(np.array([0.7])) == 0.7
    # biggest gap is between 0.9 and 0.2 -> midpoint 0.55
    assert mcut_threshold(np.array([0.9, 0.2, 0.1])) == 0.55


def test_select_tags_thresholds_and_sorts():
    preds = np.array([0.1, 0.8, 0.9, 0.3, 0.95])
    out = select_tags(_labels(), preds, general_thresh=0.35, character_thresh=0.85)
    # rating dict carries both rating labels with their probs
    assert out["rating"] == {"safe": 0.1, "explicit": 0.8}
    # only cat (0.9) passes the 0.35 general threshold; dog (0.3) drops
    assert out["general_tags"] == [("cat", 0.9)]
    # alice (0.95) passes the 0.85 character threshold
    assert out["character_tags"] == [("alice", 0.95)]
    assert out["caption"] == "cat"


def test_select_tags_max_general_caps_results():
    preds = np.array([0.0, 0.0, 0.9, 0.8, 0.0])
    out = select_tags(
        _labels(), preds, general_thresh=0.1, character_thresh=0.1, max_general=1
    )
    # both cat and dog pass, but cap=1 keeps only the top-scored (cat)
    assert out["general_tags"] == [("cat", 0.9)]


def test_select_tags_general_mcut_overrides_threshold():
    preds = np.array([0.0, 0.0, 0.9, 0.2, 0.0])
    out = select_tags(
        _labels(),
        preds,
        general_thresh=0.95,  # would drop everything...
        character_thresh=0.1,
        general_mcut=True,  # ...but mcut picks the gap midpoint (0.55)
    )
    assert out["general_tags"] == [("cat", 0.9)]


# --- Download availability / load state machine ------------------------------


def _place_model(repo: str, cache_dir: str) -> None:
    csv_path, onnx_path = _expected_paths(model_repo=repo, cache_dir=cache_dir)
    Path(onnx_path).write_text("onnx")
    Path(csv_path).write_text("csv")


def test_is_available_reflects_files_on_disk(tmp_path):
    dm = ModelDownloadManager()
    repo, cache = "Org/Model", str(tmp_path)
    assert dm.is_available(model_repo=repo, cache_dir=cache) is False
    _place_model(repo, cache)
    assert dm.is_available(model_repo=repo, cache_dir=cache) is True


async def test_download_start_skips_when_model_present(tmp_path):
    # The core "model is available -> don't re-download" behaviour: start() must
    # short-circuit to done and spawn no download task.
    dm = ModelDownloadManager()
    repo, cache = "Org/Model", str(tmp_path)
    _place_model(repo, cache)
    st = await dm.start(model_repo=repo, cache_dir=cache)
    assert st.status == "done"
    assert (repo, cache) not in dm._tasks


async def test_download_fetches_a_given_file_list(tmp_path, monkeypatch):
    # Another model (the face detector) names its own files; the key is any
    # string unique to it, never used to build a URL.
    dm = ModelDownloadManager()
    fetched: list[str] = []

    async def fake_one(st, f):
        fetched.append(f.url)
        Path(f.dst_path).write_text("x")
        f.status = "done"

    monkeypatch.setattr(dm, "_download_one", fake_one)
    files = [
        RemoteFile("model.onnx", "https://hf/a/model.onnx", str(tmp_path / "m.onnx")),
        RemoteFile("threshold.json", "https://hf/a/t.json", str(tmp_path / "t.json")),
    ]
    st = await dm.start(model_repo="org/repo:v1", cache_dir=str(tmp_path), files=files)
    await dm.wait(model_repo="org/repo:v1", cache_dir=str(tmp_path))
    assert st.status == "done"
    assert fetched == ["https://hf/a/model.onnx", "https://hf/a/t.json"]
    again = await dm.start(
        model_repo="org/repo:v1", cache_dir=str(tmp_path), files=files
    )
    assert again.status == "done" and len(fetched) == 2


async def test_start_load_supersedes_stale_target_without_clobbering(monkeypatch):
    # Changing the cache dir mid-load supersedes the stale load; the cancelled
    # task must NOT overwrite the new load's status when its CancelledError
    # unwinds (the task-identity guard in start_load._runner).
    mgr = TaggerManager()
    release = asyncio.Event()
    seen: list[str] = []

    async def fake_ensure_loaded(*, model_repo: str, cache_dir: str) -> None:
        seen.append(cache_dir)
        if cache_dir == "/wrong":
            await asyncio.sleep(3600)  # hang until superseded/cancelled
        else:
            await release.wait()  # completes only when we allow it

    monkeypatch.setattr(mgr, "ensure_loaded", fake_ensure_loaded)

    assert mgr.start_load(model_repo="r", cache_dir="/wrong") is True
    stale = mgr._load_task
    await asyncio.sleep(0)  # let the first runner reach the hang

    # User corrects the dir: supersede the stale load.
    assert mgr.start_load(model_repo="r", cache_dir="/correct") is True
    fresh = mgr._load_task
    assert fresh is not stale

    with contextlib.suppress(asyncio.CancelledError):
        await stale  # deterministically unwind the cancelled load

    # Superseded task must not have clobbered status back to "cancelled".
    assert mgr._load_status == "loading"
    assert mgr.load_status()["loading_for"] == ("r", "/correct")

    release.set()
    await fresh
    assert mgr._load_status == "loaded"
    assert seen == ["/wrong", "/correct"]


def test_start_load_same_target_in_flight_is_noop(monkeypatch):
    # A second load for the SAME (repo, cache_dir) while one is in flight must
    # not start a duplicate. It returns False and keeps the existing task.
    mgr = TaggerManager()

    async def fake_ensure_loaded(*, model_repo: str, cache_dir: str) -> None:
        await asyncio.sleep(3600)

    monkeypatch.setattr(mgr, "ensure_loaded", fake_ensure_loaded)

    async def _run() -> None:
        assert mgr.start_load(model_repo="r", cache_dir="/c") is True
        first = mgr._load_task
        await asyncio.sleep(0)
        assert mgr.start_load(model_repo="r", cache_dir="/c") is False
        assert mgr._load_task is first
        first.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await first

    asyncio.run(_run())
