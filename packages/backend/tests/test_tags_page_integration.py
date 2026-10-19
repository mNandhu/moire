"""The Tags page: one entry per tag name across sources, its detail panel, and
pinned covers keyed by name."""

import sqlalchemy as sa

from src.database import db
from src.database import schema as t
from src.services import tag_categories, tag_index, tag_migrations


async def _chars(*names):
    return frozenset(names)


async def test_browse_merges_sources_and_counts_images_once(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "character_names", lambda: _chars("hu_tao"))
    seed("L1:a", tags=("cat", "prompt:cat", "prompt:hu_tao"), mtime=100)
    seed("L1:b", tags=("prompt:cat", "manual:cat"), mtime=300)
    seed("L1:c", tags=("dog",), mtime=200)

    rows = (await client.get("/tags/browse")).json()
    by = {r["tag"]: r for r in rows}
    assert [r["tag"] for r in rows][:1] == ["cat"]
    assert by["cat"]["count"] == 2
    assert by["cat"]["last_used"] == 300
    assert by["cat"]["category"] == "general"
    assert by["hu_tao"]["category"] == "character"
    assert by["dog"]["thumb_url"].endswith("/images/L1%3Ac/thumb")

    ai = {
        r["tag"]: r["count"]
        for r in (await client.get("/tags/browse?source=ai")).json()
    }
    assert ai == {"cat": 1, "dog": 1}
    manual = (await client.get("/tags/browse?source=manual")).json()
    assert [(r["tag"], r["count"]) for r in manual] == [("cat", 1)]
    assert (await client.get("/tags/browse?source=nope")).status_code == 422


async def test_detail_describes_one_tag(client, seed):
    seed(
        "L1:a",
        tags=("cat", "prompt:cat", "night"),
        mtime=1_700_000_000,
        gen={"workflow_sig": "S1"},
    )
    seed("L1:b", tags=("prompt:cat", "night", "rain"), mtime=1_710_000_000)
    async with db.async_tx() as conn:
        await conn.execute(
            sa.insert(t.image_loras),
            [{"image_id": "L1:a", "name": "fluffy", "strength": 1.0}],
        )

    got = (await client.get("/tags/detail", params={"tag": "any:cat"})).json()
    assert got["count"] == 2
    assert got["sources"] == {"ai": 1, "prompt": 2, "manual": 0}
    assert (got["first_used"], got["last_used"]) == (1_700_000_000, 1_710_000_000)
    assert sum(m["count"] for m in got["months"]) == 2
    assert got["loras"] == [{"name": "fluffy", "count": 1}]
    assert got["workflows"] == [{"sig": "S1", "count": 1}]
    assert got["related"] == [{"tag": "night", "count": 2}, {"tag": "rain", "count": 1}]

    ai = (
        await client.get("/tags/detail", params={"tag": "cat", "source": "ai"})
    ).json()
    assert ai["count"] == 1
    missing = await client.get("/tags/detail", params={"tag": "nothing"})
    assert missing.status_code == 404


async def test_a_pin_belongs_to_the_name_whichever_source(client, seed):
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("prompt:cat",))
    # pinned through the prompt tag, an image only the prompt found
    resp = await client.post("/tags/thumbnail/prompt:cat", json={"image_id": "L1:b"})
    assert resp.status_code == 200
    rows = (await client.get("/tags/browse")).json()
    assert rows[0]["thumb_image_id"] == "L1:b"
    # and it leads the AI tag's mosaic too
    samples = (await client.get("/tags/samples?tags=any:cat&per=2")).json()
    assert samples["any:cat"][0]["_id"] == "L1:b"

    await client.delete("/tags/thumbnail/any:cat")
    async with db.async_conn() as conn:
        assert (await conn.execute(sa.select(t.tag_meta))).fetchall() == []


async def test_migration_keys_old_pins_by_name(temp_db):
    with db.sync_tx() as conn:
        conn.execute(
            sa.insert(t.tag_meta),
            [
                {"tag": "prompt:cat", "thumb_image_id": "L1:old", "updated_at": 1},
                {"tag": "manual:cat", "thumb_image_id": "L1:new", "updated_at": 2},
                {"tag": "dog", "thumb_image_id": "L1:d", "updated_at": 1},
            ],
        )
    tag_migrations.migrate_tag_meta_base()
    tag_index.invalidate()
    with db.sync_conn() as conn:
        pins = dict(
            conn.execute(
                sa.select(t.tag_meta.c.tag, t.tag_meta.c.thumb_image_id)
            ).fetchall()
        )
    assert pins == {"cat": "L1:new", "dog": "L1:d"}


async def test_any_samples_are_distinct_images(client, seed):
    # every image carries the tag from two sources: two join rows each
    for name in ("a", "b", "c"):
        seed(f"L1:{name}", tags=("cat", "prompt:cat"))
    for _ in range(6):
        tag_index.invalidate()
        got = (await client.get("/tags/samples?tags=any:cat&per=3")).json()["any:cat"]
        assert sorted(s["_id"] for s in got) == ["L1:a", "L1:b", "L1:c"]


async def test_mosaics_stay_put_when_another_tag_changes(client, seed):
    for i in range(8):
        seed(f"L1:{i}", tags=("cat", "dog"))
    url = "/tags/samples?tags=any:cat&per=4"
    before = (await client.get(url)).json()["any:cat"]
    # pinning dog's cover dirties the whole index
    await client.post("/tags/thumbnail/dog", json={"image_id": "L1:3"})
    assert (await client.get(url)).json()["any:cat"] == before
    dog = (await client.get("/tags/samples?tags=any:dog&per=4")).json()["any:dog"]
    assert dog[0]["_id"] == "L1:3"


async def test_quarantined_images_leave_the_tags_page(client, seed):
    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("cat",))
    await client.post("/tags/thumbnail/cat", json={"image_id": "L1:a"})
    await client.post("/images/L1:a/quarantine", json={"quarantined": True})

    rows = (await client.get("/tags/browse")).json()
    assert [(r["tag"], r["count"]) for r in rows] == [("cat", 1)]
    assert (await client.get("/tags/detail", params={"tag": "cat"})).json()[
        "count"
    ] == 1
    # the pin stays, but a quarantined cover isn't shown
    samples = (await client.get("/tags/samples?tags=any:cat&per=4")).json()["any:cat"]
    assert [s["_id"] for s in samples] == ["L1:b"]

    await client.post("/images/L1:a/quarantine", json={"quarantined": False})
    samples = (await client.get("/tags/samples?tags=any:cat&per=4")).json()["any:cat"]
    assert samples[0]["_id"] == "L1:a"


async def test_characters_lists_only_characters(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "character_names", lambda: _chars("frieren"))
    seed("L1:a", tags=("prompt:frieren", "prompt:cat"))
    got = (await client.get("/tags/characters")).json()
    assert [(c["tag"], c["count"]) for c in got] == [("frieren", 1)]
    assert got[0]["thumb_url"].endswith("/images/L1%3Aa/thumb")


async def test_the_list_cover_is_the_mosaics_first_image(client, seed):
    for i in range(12):
        seed(f"L1:{i:02}", tags=("cat", "prompt:dog") if i % 2 else ("prompt:cat",))

    async def lead(tag):
        got = (await client.get(f"/tags/samples?tags=any:{tag}&per=4")).json()
        return got[f"any:{tag}"][0]["_id"]

    covers = {
        r["tag"]: r["thumb_image_id"] for r in (await client.get("/tags/browse")).json()
    }
    assert covers["cat"] == await lead("cat")
    assert covers["dog"] == await lead("dog")
    # a pin leads both; quarantining it hands both to the shuffle again
    await client.post("/tags/thumbnail/cat", json={"image_id": "L1:05"})
    covers = {
        r["tag"]: r["thumb_image_id"] for r in (await client.get("/tags/browse")).json()
    }
    assert covers["cat"] == await lead("cat") == "L1:05"
    await client.post("/images/L1:05/quarantine", json={"quarantined": True})
    covers = {
        r["tag"]: r["thumb_image_id"] for r in (await client.get("/tags/browse")).json()
    }
    assert covers["cat"] == await lead("cat") != "L1:05"
