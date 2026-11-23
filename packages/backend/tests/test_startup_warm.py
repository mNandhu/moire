"""The tag views built in the background after startup."""

from __future__ import annotations

from moire.services import startup
from moire.services.tags import index as tag_index


async def test_startup_builds_the_tags_list_and_the_character_list(seed, monkeypatch):
    seed("L1:a", tags=("nahida_(genshin_impact)", "1girl"))
    monkeypatch.setattr(startup, "_WARM_DELAY_S", 0.0)
    await startup._warm_views()
    browse = tag_index.peek("views", "browse:all")
    assert {r["tag"] for r in browse} >= {"1girl", "nahida_(genshin_impact)"}
    assert tag_index.peek("views", "characters") is not None


async def test_a_failed_warm_up_is_only_logged(monkeypatch, caplog):
    async def broken(source: str = "all") -> list[dict]:
        raise RuntimeError("no database")

    monkeypatch.setattr(startup, "_WARM_DELAY_S", 0.0)
    monkeypatch.setattr(startup.tag_browse, "browse", broken)
    await startup._warm_views()
    assert "Building the tag views at startup failed" in caplog.text
