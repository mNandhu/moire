"""Schema definition tests: assert the SQLite tables, key columns, and the index
set exist as the query layer expects. Pure metadata introspection, no DB needed.
"""

from src.database import schema


def test_expected_tables_exist():
    assert set(schema.metadata.tables) == {
        "images",
        "image_tags",
        "image_gen_terms",
        "libraries",
        "image_gen_raw",
        "tag_meta",
        "characters",
        "image_faces",
        "tag_aliases",
        "image_loras",
        "image_embeddings",
        "gen_rulesets",
        "workflow_names",
        "workflow_files",
        "app_settings",
        "comfy_models",
        "lora_choices",
        "recipe_edits",
        "recipe_additions",
        "prompt_presets",
        "lora_presets",
        "generators",
        "generation_batches",
        "generation_requests",
        "generation_outputs",
        "generation_run_times",
        "tag_focus",
    }


def test_images_has_tag_state_and_promoted_gen_columns():
    cols = set(schema.images.c.keys())
    # Tag-state summary flags + the ordered tag array.
    assert {"has_tags", "has_ai_tags", "has_prompt_tags", "tags"} <= cols
    # Promoted gen.* scalars used by indexed feed filters.
    assert {"gen_model", "gen_workflow_sig", "gen_group_id", "gen_prompt"} <= cols


def test_id_columns_collate_binary_for_cursor_pagination():
    # `_id` is the feed cursor's tie-break; it must keep Mongo's byte-order sort.
    assert schema.images.c._id.type.collation == "BINARY"


def test_derived_join_tables_have_base_and_term():
    assert "base" in schema.image_tags.c.keys()
    assert "term" in schema.image_gen_terms.c.keys()


def test_expected_indexes_present():
    names = {ix.name for tbl in schema.metadata.tables.values() for ix in tbl.indexes}
    assert {
        "ix_images_recent",
        "ix_images_top",
        "ix_images_lib_recent",
        "ix_images_lib_top",
        "ix_images_lib_has_ai_tags_recent",
        "ix_images_model_recent",
        "ix_images_sig_recent",
        "ix_image_tags_tag_img",
        "ix_image_tags_base_img",
        "ix_image_gen_terms_term",
        "ix_gen_raw_sig",
    } <= names
    # Retired indexes are dropped, never redefined.
    assert not names & set(schema.RETIRED_INDEXES)


def test_ensure_schema_drops_retired_and_is_idempotent(tmp_path, monkeypatch):
    import sqlalchemy as sa

    from src.database import db

    engine = sa.create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        schema.metadata.create_all(conn)
        conn.exec_driver_sql("CREATE INDEX ix_images_lib_id ON images (library_id)")
    monkeypatch.setattr(db, "get_sync_engine", lambda: engine)
    db.ensure_schema_sync()
    db.ensure_schema_sync()
    with engine.connect() as conn:
        names = {
            r[0]
            for r in conn.exec_driver_sql(
                "select name from sqlite_master where type='index'"
            )
        }
    assert "ix_images_lib_id" not in names
    assert "ix_images_lib_top" in names
