"""Integration-test harness.

SQLite removes the barrier that kept Moiré's tests pure-logic only: a temp-file
DB spins up with zero infrastructure, so router-level tests can run against a real
database. Each test gets its own DB file (full isolation) and an httpx client
wired to the ASGI app.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import pytest_asyncio
import sqlalchemy as sa

from src.core.config import settings
from src.database import db
from src.database import schema as t
from src.services import image_tags, tag_index


@pytest.fixture(autouse=True)
def fresh_tag_index():
    """The tag index cache is module-global; drop it around every test so a
    cached aggregation can't leak across DB fixtures."""
    tag_index.reset_for_tests()
    yield
    tag_index.reset_for_tests()


@pytest_asyncio.fixture
async def temp_db(tmp_path: Path):
    """Point the engines at a fresh temp-file DB and create the schema."""
    settings.sqlite_path = str(tmp_path / "test.db")
    settings.thumb_root = str(tmp_path / "thumbs")
    await db.reset_engines()
    await db.ensure_schema()
    yield
    await db.reset_engines()


@pytest_asyncio.fixture
async def client(temp_db):
    """An httpx client bound to the ASGI app (no network, no lifespan)."""
    from src.main import API_PREFIX, app

    transport = httpx.ASGITransport(app=app)
    # Every route lives under API_PREFIX; httpx joins a leading-slash path onto
    # the base URL's path, so tests address routes as `/images`, `/tags`, ...
    async with httpx.AsyncClient(
        transport=transport, base_url=f"http://test{API_PREFIX}"
    ) as c:
        yield c


def _gen_cols(gen: dict | None) -> dict:
    g = gen or {}
    return {
        "gen": gen,
        "gen_model": g.get("model"),
        "gen_workflow_sig": g.get("workflow_sig"),
        "gen_group_id": g.get("group_id"),
        "gen_prompt": g.get("prompt"),
    }


@pytest.fixture
def seed():
    """Insert image rows (with derived tag / prompt-term rows) straight into the DB.

    Mirrors what the scanner + reproject would persist, so feed/tag queries have
    realistic data to read.
    """

    def _seed(
        image_id: str,
        *,
        library_id: str = "L1",
        tags: tuple[str, ...] = (),
        gen: dict | None = None,
        width: int | None = None,
        height: int | None = None,
        quarantined: bool = False,
        score: float = 0,
        rating: str | None = None,
        thumb_key: str | None = None,
    ) -> None:
        tag_list = list(tags)
        flags = image_tags.recompute_flags(tag_list)
        with db.sync_tx() as conn:
            conn.execute(
                sa.insert(t.images).values(
                    _id=image_id,
                    library_id=library_id,
                    tags=tag_list,
                    width=width,
                    height=height,
                    quarantined=quarantined,
                    score=score,
                    rating=rating,
                    thumb_key=thumb_key,
                    **flags,
                    **_gen_cols(gen),
                )
            )
            rows = image_tags._tag_rows(image_id, tag_list)
            if rows:
                conn.execute(sa.insert(t.image_tags), rows)
            terms = list(dict.fromkeys((gen or {}).get("prompt_terms", [])))
            if terms:
                conn.execute(
                    sa.insert(t.image_gen_terms),
                    [{"image_id": image_id, "term": term} for term in terms],
                )

    return _seed
