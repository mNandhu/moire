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
