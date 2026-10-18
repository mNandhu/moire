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
        "gen_rulesets",
        "app_settings",
    }


def test_images_has_tag_state_and_promoted_gen_columns():
    cols = set(schema.images.c.keys())
    # Tag-state summary flags + the ordered tag array.
    assert {"has_tags", "has_ai_tags", "has_prompt_tags", "tags"} <= cols
    # Promoted gen.* scalars used by indexed feed filters.
    assert {"gen_model", "gen_workflow_sig", "gen_group_id", "gen_prompt"} <= cols


def test_id_columns_collate_binary_for_cursor_pagination():
    # Cursor paging compares `_id < cursor`; it must match Mongo's byte-order sort.
    assert schema.images.c._id.type.collation == "BINARY"


def test_derived_join_tables_have_base_and_term():
    assert "base" in schema.image_tags.c.keys()
    assert "term" in schema.image_gen_terms.c.keys()


def test_expected_indexes_present():
    names = {ix.name for tbl in schema.metadata.tables.values() for ix in tbl.indexes}
    assert {
        "ix_images_lib_id",
        "ix_images_lib_has_ai_tags",
        "ix_images_gen_model",
        "ix_image_tags_tag",
        "ix_image_tags_base",
        "ix_image_gen_terms_term",
        "ix_gen_raw_sig",
    } <= names
