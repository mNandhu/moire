"""The one-off underscore migration: spaced tags become canonical, the ai
subdoc follows, duplicate spellings collapse, and it runs once."""

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import tag_migrations


async def _row(image_id):
    async with db.async_conn() as conn:
        return (
            await conn.execute(sa.select(t.images).where(t.images.c._id == image_id))
        ).first()


async def test_migration_rewrites_tags_ai_meta_and_pins(temp_db, seed):
    seed("L1:a", tags=("blue eyes", "^_^", "manual:my pick", "prompt:blue eyes"))
    seed("L1:b", tags=("long hair", "manual:long hair", "manual:long_hair"))
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images)
            .where(t.images.c._id == "L1:a")
            .values(
                ai={"general_tags": [["blue eyes", 0.9], ["^_^", 0.5]], "caption": "x"}
            )
        )
        conn.execute(
            sa.insert(t.tag_meta),
            [
                {"tag": "blue eyes", "thumb_image_id": "L1:a", "updated_at": 1.0},
                {"tag": "blue_eyes", "thumb_image_id": "L1:b", "updated_at": 2.0},
            ],
        )

    tag_migrations.run_pending()

    a = await _row("L1:a")
    assert a.tags == ["blue_eyes", "^_^", "manual:my_pick", "prompt:blue_eyes"]
    assert a.ai["general_tags"] == [["blue_eyes", 0.9], ["^_^", 0.5]]
    assert a.has_ai_tags is True
    b = await _row("L1:b")
    assert b.tags == ["long_hair", "manual:long_hair"]
    async with db.async_conn() as conn:
        rows = {r.tag for r in (await conn.execute(sa.select(t.image_tags))).fetchall()}
        pins = (await conn.execute(sa.select(t.tag_meta))).fetchall()
    assert "blue eyes" not in rows and "blue_eyes" in rows
    assert [(p.tag, p.thumb_image_id) for p in pins] == [("blue_eyes", "L1:b")]


async def test_migration_runs_once(temp_db, seed):
    tag_migrations.run_pending()
    seed("L1:a", tags=("blue eyes",))  # written after: left alone
    tag_migrations.run_pending()
    assert (await _row("L1:a")).tags == ["blue eyes"]


async def test_fresh_install_reprojects_once(temp_db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        tag_migrations.reproject,
        "reproject_all",
        lambda force=False: calls.append(force) or 0,
    )
    tag_migrations.run_pending()
    assert calls == [True]  # once, forced: steps may add derived tables
    tag_migrations.run_pending()
    assert calls == [True]


async def test_rules_migration_moves_merges_and_splits_into_one_table(temp_db):
    with db.sync_tx() as conn:
        conn.execute(
            sa.text(
                "CREATE TABLE tag_aliases (from_name TEXT PRIMARY KEY,"
                " to_name TEXT NOT NULL, created_at FLOAT)"
            )
        )
        conn.execute(
            sa.text("INSERT INTO tag_aliases VALUES ('blonde', 'blonde_hair', 1.0)")
        )
        conn.execute(
            sa.text(
                "CREATE TABLE tag_splits (from_name TEXT PRIMARY KEY,"
                " to_names JSON NOT NULL, created_at FLOAT)"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO tag_splits VALUES"
                " ('long_white_hair', '[\"long_hair\", \"white_hair\"]', 2.0)"
            )
        )

    tag_migrations.migrate_tag_rules()
    with db.sync_conn() as conn:
        rows = {
            r.from_name: list(r.to_names) for r in conn.execute(sa.select(t.tag_rules))
        }
        tables = set(sa.inspect(conn).get_table_names())
    assert rows == {
        "blonde": ["blonde_hair"],
        "long_white_hair": ["long_hair", "white_hair"],
    }
    assert not tables & {"tag_aliases", "tag_splits"}
    # Run again (nothing left to move): a no-op.
    tag_migrations.migrate_tag_rules()


def test_gen_term_weights_adds_the_column_and_keeps_the_rows(temp_db):
    from moire.services.tag_migrations import migrate_gen_term_weights

    with db.sync_tx() as conn:
        conn.execute(sa.text("DROP TABLE image_gen_terms"))
        conn.execute(sa.text("CREATE TABLE image_gen_terms (image_id TEXT, term TEXT)"))
        conn.execute(sa.text("INSERT INTO image_gen_terms VALUES ('L1:a', 'cat')"))
    migrate_gen_term_weights()
    migrate_gen_term_weights()  # idempotent
    with db.sync_conn() as conn:
        rows = conn.execute(
            sa.text("SELECT image_id, term, weight FROM image_gen_terms")
        ).all()
    assert [tuple(r) for r in rows] == [("L1:a", "cat", 1.0)]
