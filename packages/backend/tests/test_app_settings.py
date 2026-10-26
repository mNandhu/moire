"""The shared app_settings row helper: missing rows read as None, writes
replace the whole document, sync and async see the same rows."""

from __future__ import annotations

from moire.services import app_settings


async def test_missing_row_reads_none(temp_db):
    assert await app_settings.read("nope") is None


async def test_write_replaces_whole_doc(temp_db):
    await app_settings.write("r", {"a": 1, "b": 2})
    await app_settings.write("r", {"a": 3})
    assert await app_settings.read("r") == {"a": 3}


async def test_sync_and_async_share_rows(temp_db):
    app_settings.write_sync("s", {"x": 1})
    assert await app_settings.read("s") == {"x": 1}
    await app_settings.write("s", {"x": 2})
    assert app_settings.read_sync("s") == {"x": 2}
