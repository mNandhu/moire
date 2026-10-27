"""Model download: a failed download surfaces its own error to the load."""

import pytest

from moire.services import ai_tagger_download as dl


async def test_a_failed_download_raises_its_own_error(monkeypatch, tmp_path):
    mgr = dl.ModelDownloadManager()

    async def broken(st):
        raise RuntimeError("HTTP 404 for org/typo")

    monkeypatch.setattr(mgr, "_download_all", broken)
    monkeypatch.setattr(dl, "get_download_manager", lambda: mgr)
    with pytest.raises(RuntimeError, match="HTTP 404"):
        await dl.download_wd_tagger("org/typo", cache_dir=str(tmp_path))


async def test_a_download_counts_as_ended_under_its_kind(monkeypatch, tmp_path):
    from moire.services import activity

    mgr = dl.ModelDownloadManager()

    async def done(st):
        return None

    monkeypatch.setattr(mgr, "_download_all", done)
    before = activity.ended()
    await mgr.start(model_repo="org/a", cache_dir=str(tmp_path))
    await mgr.wait(model_repo="org/a", cache_dir=str(tmp_path))
    await mgr.start(model_repo="org/b", cache_dir=str(tmp_path), kind="face_download")
    await mgr.wait(model_repo="org/b", cache_dir=str(tmp_path))
    after = activity.ended()
    for kind in ("model_download", "face_download"):
        assert after.get(kind, 0) == before.get(kind, 0) + 1
