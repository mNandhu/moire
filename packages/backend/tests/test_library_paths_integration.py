"""Add and edit compare library folders by `library_nesting.path_key`, the
same key the add-library preview uses to call a folder registered."""

import os

import pytest
import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import library_nesting

pytestmark = pytest.mark.asyncio


def _case_folding(monkeypatch):
    # What normcase does on Windows, on any OS.
    monkeypatch.setattr(
        library_nesting, "path_key", lambda p: os.path.normpath(str(p)).lower()
    )


async def test_add_dedupes_a_folder_spelled_in_another_case(
    client, temp_db, tmp_path, monkeypatch
):
    _case_folding(monkeypatch)
    lib = tmp_path / "Images"
    lib.mkdir()
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries),
            {"_id": "L", "path": str(lib).upper() + os.sep, "name": "l"},
        )
    resp = await client.post("/libraries", json={"path": str(lib)})
    assert resp.status_code == 200, resp.text
    assert resp.json()["_id"] == "L"
    with db.sync_conn() as conn:
        assert (
            conn.execute(sa.select(sa.func.count()).select_from(t.libraries)).scalar()
            == 1
        )


async def test_a_case_only_edit_is_not_a_move(client, temp_db, tmp_path, monkeypatch):
    _case_folding(monkeypatch)
    lib = tmp_path / "Images"
    lib.mkdir()
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.libraries), {"_id": "L", "path": str(lib), "name": "l"}
        )
    from moire.api import libraries

    moved = []
    monkeypatch.setattr(libraries, "restart_scan", lambda *a: moved.append(a))
    (tmp_path / "images").mkdir()  # the PATCH checks the folder exists
    resp = await client.patch("/libraries/L", json={"path": str(tmp_path / "images")})
    assert resp.status_code == 200, resp.text
    assert moved == []
