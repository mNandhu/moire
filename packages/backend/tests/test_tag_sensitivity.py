"""Tag sensitivity levels: the shipped list, each image's derived ``tag_level``
on every tag writer, this library's own levels, and the hand-picked rating
that AI tagging leaves alone."""

from __future__ import annotations

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import app_settings
from moire.services.tags import (
    image_tags,
    index as tag_index,
    migrations as tag_migrations,
    sensitivity as ts,
)
import pytest

# Stand-ins for the shipped list (levels 1 sensitive .. 3 explicit).
SENSITIVE, QUESTIONABLE, EXPLICIT = "level_one_tag", "level_two_tag", "level_three_tag"


@pytest.fixture(autouse=True)
def shipped_levels():
    ts.ship_for_tests({SENSITIVE: 1, QUESTIONABLE: 2, EXPLICIT: 3})


def _row(image_id: str):
    with db.sync_conn() as conn:
        return conn.execute(
            sa.select(t.images).where(t.images.c._id == image_id)
        ).first()


# --- the shipped list and the pure level --------------------------------------


def test_shipped_file_names_no_tag():
    """The shipped file is keyed by hash: no tag name appears in it."""
    ts.reset_for_tests()  # the real file, not the stand-in
    shipped = ts.shipped()
    assert len(shipped) > 1000
    assert all(len(k) == ts.HASH_CHARS and int(k, 16) >= 0 for k in shipped)
    assert set(shipped.values()) <= {1, 2, 3}  # general is never listed
    assert ts.level_of("1girl") == ts.level_of("yellow_eyes") == 0


def test_hash_ignores_case():
    assert ts.hash_tag("Some_Tag") == ts.hash_tag("some_tag")
    assert ts.level_of(f"manual:{EXPLICIT.upper()}") == 3


def test_tag_level_is_the_highest_by_base_name():
    assert ts.tag_level([]) is None
    assert ts.tag_level(["yellow_eyes"]) == 0
    assert ts.tag_level(["1girl", f"prompt:{SENSITIVE}"]) == 1
    assert ts.tag_level([f"manual:{EXPLICIT}", SENSITIVE]) == 3
    assert ts.tag_level([f"manual:{EXPLICIT.upper()}"]) == 3


# --- every tag writer keeps tag_level ------------------------------------------


def test_initial_tag_fields_have_no_level():
    assert image_tags.initial_tag_fields()["tag_level"] is None


async def test_single_and_bulk_writes_set_tag_level(seed):
    seed("L1:a", tags=("1girl",))
    seed("L1:b", tags=("1girl",))
    assert _row("L1:a").tag_level == 0

    await image_tags.apply_manual("L1:a", [QUESTIONABLE])
    assert _row("L1:a").tag_level == 2
    await image_tags.remove_tags("L1:a", [f"manual:{QUESTIONABLE}"])
    assert _row("L1:a").tag_level == 0

    await image_tags.bulk_manual(["L1:b"], add=[EXPLICIT], remove=[])
    assert _row("L1:b").tag_level == 3


def test_sync_writers_set_tag_level(seed):
    seed("L1:a", tags=("1girl",))
    seed("L1:b")
    with db.sync_tx() as conn:
        image_tags.replace_prompt_many_sync(
            conn, [("L1:a", ["1girl"], [f"prompt:{SENSITIVE}"])]
        )
        image_tags.rewrite_tags_sync(conn, "L1:b", [EXPLICIT])
    assert _row("L1:a").tag_level == 1
    assert _row("L1:b").tag_level == 3


async def test_seed_matches_a_real_write(seed):
    seed("L1:a", tags=(f"prompt:{QUESTIONABLE}",))
    assert _row("L1:a").tag_level == 2


# --- the hand-picked rating -----------------------------------------------------

_SCORES = {"general": 0.1, "sensitive": 0.2, "questionable": 0.6, "explicit": 0.1}


def test_ai_rating_label_picks_the_top_score():
    assert image_tags.ai_rating_label(_SCORES) == "questionable"
    assert image_tags.ai_rating_label({}) == "-"
    assert image_tags.ai_rating_label(None) == "-"
    assert image_tags.ai_rating_label({"safe": 1.0}) == "general"


async def test_ai_writes_keep_a_hand_picked_rating(seed):
    seed("L1:a", rating="general", rating_manual=True)
    seed("L1:b", rating="general")
    for image_id in ("L1:a", "L1:b"):
        await image_tags.replace_ai(
            image_id, ai_tags=["1girl"], ai_meta={}, rating="explicit"
        )
    assert _row("L1:a").rating == "general"
    assert _row("L1:b").rating == "explicit"

    await image_tags.clear_ai("L1:a")
    await image_tags.clear_ai("L1:b")
    assert _row("L1:a").rating == "general"
    assert _row("L1:b").rating == "-"


async def test_clear_all_keeps_a_hand_picked_rating(seed):
    seed("L1:a", tags=("1girl",), rating="sensitive", rating_manual=True)
    seed("L1:b", tags=("1girl",), rating="sensitive")
    await image_tags.clear_ai_all()
    assert _row("L1:a").rating == "sensitive"
    assert _row("L1:b").rating == "-"


async def test_unrated_hands_the_rating_back_to_the_ai(client, seed):
    seed("L1:a", tags=("1girl",))
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images)
            .where(t.images.c._id == "L1:a")
            .values(ai={"rating": _SCORES})
        )
    resp = await client.post("/images/L1:a/rating", json={"rating": "general"})
    assert resp.json()["rating"] == "general"
    assert _row("L1:a").rating_manual

    resp = await client.post("/images/L1:a/rating", json={"rating": "-"})
    assert resp.json() == {"_id": "L1:a", "rating": "questionable"}
    row = _row("L1:a")
    assert (row.rating, row.rating_manual) == ("questionable", False)


async def test_unrated_without_ai_scores_is_unrated(client, seed):
    seed("L1:a", rating="explicit", rating_manual=True)
    resp = await client.post("/images/L1:a/rating", json={"rating": "-"})
    assert resp.json()["rating"] == "-"


# --- migration ----------------------------------------------------------------


def test_rating_manual_migration_marks_ratings_the_ai_did_not_pick(seed):
    seed("L1:ai", rating="questionable")
    seed("L1:changed", rating="general")
    seed("L1:no_scores", rating="sensitive")
    seed("L1:unrated", rating="-")
    seed("L1:null")
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images)
            .where(t.images.c._id.in_(["L1:ai", "L1:changed"]))
            .values(ai={"rating": _SCORES})
        )
    tag_migrations.migrate_rating_manual()
    manual = {
        i: bool(_row(i).rating_manual)
        for i in ("L1:ai", "L1:changed", "L1:no_scores", "L1:unrated", "L1:null")
    }
    assert manual == {
        "L1:ai": False,
        "L1:changed": True,
        "L1:no_scores": True,
        "L1:unrated": False,
        "L1:null": False,
    }


def test_columns_added_to_the_schema_reach_an_older_database(temp_db):
    with db.sync_tx() as conn:
        conn.execute(sa.text("ALTER TABLE images DROP COLUMN tag_level"))
        conn.execute(sa.text("ALTER TABLE images DROP COLUMN rating_manual"))
    db.ensure_schema_sync()
    db.ensure_schema_sync()  # idempotent
    with db.sync_conn() as conn:
        cols = {c["name"]: c for c in sa.inspect(conn).get_columns("images")}
        conn.execute(sa.text("INSERT INTO images (_id, library_id) VALUES ('x', 'L1')"))
        row = conn.execute(
            sa.text("SELECT rating_manual, tag_level FROM images WHERE _id = 'x'")
        ).one()
    assert {"tag_level", "rating_manual"} <= cols.keys()
    assert tuple(row) == (0, None)  # the declared default


# --- recomputing when levels change -------------------------------------------


def _set_stale(image_id: str, level: int | None) -> None:
    with db.sync_tx() as conn:
        conn.execute(
            sa.update(t.images)
            .where(t.images.c._id == image_id)
            .values(tag_level=level)
        )


def test_sync_levels_recomputes_when_the_fingerprint_changes(seed):
    seed("L1:a", tags=(EXPLICIT,))
    seed("L1:b")
    _set_stale("L1:a", None)
    _set_stale("L1:b", 2)
    assert ts.sync_levels() == 2
    assert (_row("L1:a").tag_level, _row("L1:b").tag_level) == (3, None)

    _set_stale("L1:a", 0)  # same fingerprint: left alone
    assert ts.sync_levels() == 0
    assert _row("L1:a").tag_level == 0

    app_settings.write_sync("tag_levels", {"fingerprint": "old list"})
    assert ts.sync_levels() == 1
    assert _row("L1:a").tag_level == 3


async def test_set_level_recomputes_only_images_with_the_tag(seed):
    seed("L1:a", tags=("1girl", "manual:My_Lora_Word"))
    seed("L1:b", tags=("1girl",))
    _set_stale("L1:b", 3)  # not touched: it doesn't carry the tag

    assert await ts.set_level("My Lora Word", "questionable") == 1
    assert _row("L1:a").tag_level == 2
    assert _row("L1:b").tag_level == 3
    assert ts.overrides() == {"my_lora_word": ("questionable", "user")}

    # A suggestion never replaces a level set by hand.
    assert await ts.set_level("my_lora_word", "general", source="suggested") == 0
    assert _row("L1:a").tag_level == 2

    # Nor drops one.
    assert await ts.set_level("my_lora_word", None, source="suggested") == 0
    assert ts.overrides() == {"my_lora_word": ("questionable", "user")}

    # Back to the shipped level (unlisted: general).
    await ts.set_level("my_lora_word", None)
    assert _row("L1:a").tag_level == 0
    assert ts.overrides() == {}


async def test_a_library_level_can_lower_a_shipped_one(seed):
    seed("L1:a", tags=(SENSITIVE,))
    await ts.set_level(SENSITIVE, "general")
    assert _row("L1:a").tag_level == 0


async def test_set_level_survives_a_restart_and_marks_the_index_stale(seed):
    seed("L1:a", tags=("prompt:my_lora_word",))
    await ts.set_level("my_lora_word", "explicit")
    tag_index.invalidate()  # whatever was cached
    ts.reset_for_tests()  # a restart: the map is read again
    ts.load_overrides_sync()
    assert ts.sync_levels() == 0  # the stored fingerprint already matches
    assert ts.tag_level(["prompt:my_lora_word"]) == 3


async def test_set_level_matches_tags_in_any_case(seed):
    seed("L1:a", tags=("manual:Ünique_Tag",))
    seed("L1:b", tags=("manual:ÜNIQUE_TAG",))
    assert await ts.set_level("ünique_tag", "sensitive") == 2
    assert (_row("L1:a").tag_level, _row("L1:b").tag_level) == (1, 1)
