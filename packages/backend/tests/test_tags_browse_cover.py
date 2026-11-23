"""The Tags page's one-pass aggregate (``browse._browse``): the cover rule,
the pack bound and the ``bases`` path."""

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services.tags import (
    browse as tag_browse,
    categories as tag_categories,
    covers as tag_covers,
)


async def _rowids():
    async with db.async_conn() as conn:
        rows = await conn.execute(
            sa.select(t.images.c._id, sa.literal_column("rowid")).where(
                t.images.c.quarantined.is_(False)
            )
        )
        return {r[0]: r[1] for r in rows}


async def _expected_cover(tag, carrying):
    """The cover by the rule, in plain Python: the lowest shuffle rank (rowid
    breaks a tie) among the visible images carrying the tag."""
    ids = await _rowids()
    seed = tag_covers._seed(tag)
    return min(
        carrying,
        key=lambda i: (tag_covers.shuffle_rank(ids[i], seed), ids[i]),
    )


async def _pin_directly(tag, image_id):
    async with db.async_tx() as conn:
        await conn.execute(
            sa.insert(t.tag_meta).values(tag=tag, thumb_image_id=image_id, updated_at=1)
        )


async def _covers(source="all", bases=None):
    vocab = tag_categories.Vocab(frozenset(), {})
    rows = await tag_browse._browse(source, bases, vocab)
    return {r["tag"]: r["thumb_image_id"] for r in rows}


async def test_cover_follows_the_shuffle_rule(temp_db, seed):
    names = [f"L1:{i:02}" for i in range(15)]
    for n in names:
        seed(n, tags=("cat",))
    assert (await _covers())["cat"] == await _expected_cover("cat", names)
    assert (await _covers("ai"))["cat"] == await _expected_cover("cat", names)


async def test_cover_is_the_pin_when_visible_and_tagged(temp_db, seed):
    names = [f"L1:{i:02}" for i in range(15)]
    for n in names:
        seed(n, tags=("cat",))
    shuffle = await _expected_cover("cat", names)
    pin = next(n for n in names if n != shuffle)
    await _pin_directly("cat", pin)
    assert (await _covers())["cat"] == pin
    assert (await _covers("ai"))["cat"] == pin


async def test_a_hidden_pin_falls_back_to_the_shuffle(temp_db, seed):
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("cat",))
    seed("L1:c", tags=("cat",), quarantined=True)
    await _pin_directly("cat", "L1:c")
    expected = await _expected_cover("cat", ["L1:a", "L1:b"])
    assert (await _covers())["cat"] == expected
    assert (await _covers("ai"))["cat"] == expected


async def test_a_pin_must_carry_the_tag_in_that_source(temp_db, seed):
    # the pinned image has the name only as a prompt tag: the AI list skips it
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("cat",))
    seed("L1:p", tags=("prompt:cat",))
    await _pin_directly("cat", "L1:p")
    assert (await _covers("ai"))["cat"] == await _expected_cover(
        "cat", ["L1:a", "L1:b"]
    )
    assert (await _covers("prompt"))["cat"] == "L1:p"
    assert (await _covers("all"))["cat"] == "L1:p"
    # a pin on an image without the tag at all is ignored
    seed("L1:z", tags=("dog",))
    await _pin_directly("dog", "L1:a")
    assert (await _covers())["dog"] == "L1:z"


async def test_covers_survive_rowids_at_the_pack_bound(temp_db, seed):
    bound = tag_browse._PACK - 1  # the largest rowid a cover may have
    names = [f"L1:{i:02}" for i in range(6)]
    for n in names:
        seed(n, tags=("cat",))
    seed("L1:x", tags=("dog",))
    async with db.async_tx() as conn:
        for k, n in enumerate(names[:3]):
            await conn.execute(
                sa.text("UPDATE images SET rowid = :r WHERE _id = :i"),
                {"r": bound - k, "i": n},
            )
        await conn.execute(
            sa.text("UPDATE images SET rowid = :r WHERE _id = 'L1:x'"),
            {"r": bound - 10},
        )
    assert (await _covers())["cat"] == await _expected_cover("cat", names)
    # pinned: a negative packed key decodes back to the same large rowid
    await _pin_directly("cat", names[0])
    await _pin_directly("dog", "L1:x")
    got = await _covers()
    assert got["cat"] == names[0]
    assert got["dog"] == "L1:x"


async def test_rowids_past_the_pack_bound_take_the_other_shape(temp_db, seed):
    names = [f"L1:{i:02}" for i in range(6)]
    for n in names:
        seed(n, tags=("cat",))
    async with db.async_tx() as conn:
        await conn.execute(
            sa.text("UPDATE images SET rowid = :r WHERE _id = :i"),
            {"r": tag_browse._PACK + 5, "i": names[0]},
        )
    assert (await _covers())["cat"] == await _expected_cover("cat", names)
    await _pin_directly("cat", names[0])
    assert (await _covers())["cat"] == names[0]


async def test_bases_only_returns_those_tags(temp_db, seed):
    for i in range(6):
        seed(f"L1:{i}", tags=("cat", "dog") if i % 2 else ("cat", "prompt:bird"))
    await _pin_directly("dog", "L1:3")
    everything = await _covers()
    got = await _covers("all", ["dog", "bird"])
    assert set(got) == {"dog", "bird"}
    assert got["dog"] == "L1:3"
    assert got["bird"] == everything["bird"]
    assert set(await _covers("ai", ["dog", "bird"])) == {"dog"}
    assert await _covers("all", ["nope"]) == {}
