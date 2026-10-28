"""image_tags.find_image reads only the columns asked for (the thumb and file
routes fire once per grid tile), always with ``_id``."""

from moire.services import image_tags


async def test_columns_limit_the_read_to_those_and_the_id(seed):
    seed("L1:a/b.jpg", tags=("cat",))
    doc = await image_tags.find_image("L1:a/b.jpg", ("thumb_key",))
    assert set(doc) == {"_id", "thumb_key"}
    assert doc["_id"] == "L1:a/b.jpg"


async def test_a_mongo_style_projection_still_reads_its_keys(seed):
    """Callers not yet moved off ``{"path": 1}`` get the same narrow read."""
    seed("L1:a.jpg", tags=("cat",))
    doc = await image_tags.find_image("L1:a.jpg", {"path": 1, "thumb_key": 1})
    assert set(doc) == {"_id", "path", "thumb_key"}


async def test_no_columns_is_the_whole_document(seed):
    seed("L1:a.jpg", tags=("cat",))
    doc = await image_tags.find_image("L1:a.jpg")
    assert doc["tags"] == ["cat"]
    assert "gen_model" not in doc  # promoted helper columns stay hidden
    assert {"path", "thumb_key", "rating", "has_tags"} <= set(doc)


async def test_columns_tolerate_the_other_slash(seed):
    seed("L1:a/b.jpg", tags=("cat",))
    doc = await image_tags.find_image("L1:a\\b.jpg", ("path",))
    assert doc["_id"] == "L1:a/b.jpg"


async def test_unknown_image_is_none(seed):
    assert await image_tags.find_image("L1:nope.jpg", ("path",)) is None
