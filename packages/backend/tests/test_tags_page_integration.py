"""The Tags page: one entry per tag name across sources, its detail panel, and
pinned covers keyed by name."""

import sqlalchemy as sa

from moire.database import db
from moire.database import schema as t
from moire.services import tag_categories, tag_index, tag_migrations


def _chars(*names, **candidates):
    async def load():
        return tag_categories.Vocab(
            frozenset(names),
            {
                bare: tag_categories.Candidate(series, f"{bare}_({series})")
                for bare, series in candidates.items()
            },
        )

    return load


async def test_browse_merges_sources_and_counts_images_once(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars("hu_tao"))
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
    assert by["dog"]["thumb_url"].split("?")[0].endswith("/images/L1%3Ac/thumb")

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
    assert got["loras"] == [{"name": "fluffy", "count": 1, "strength": 1.0}]
    assert got["workflows"] == [{"sig": "S1", "count": 1}]
    assert got["related"] == [{"tag": "night", "count": 2}, {"tag": "rain", "count": 1}]
    assert got["weights"] is None  # no prompt weighted it

    ai = (
        await client.get("/tags/detail", params={"tag": "cat", "source": "ai"})
    ).json()
    assert ai["count"] == 1
    missing = await client.get("/tags/detail", params={"tag": "nothing"})
    assert missing.status_code == 404


async def test_detail_gives_the_prompt_weight_spread(client, seed):
    def prompted(image_id, weight=None):
        weights = {"cat": weight} if weight is not None else {}
        seed(
            image_id,
            tags=("prompt:cat",),
            gen={"prompt_terms": ["cat"], "prompt_weights": weights},
        )

    prompted("L1:a", 1.2)
    prompted("L1:b", 1.2)
    prompted("L1:c", 0.8)
    prompted("L1:d")
    seed("L1:e", tags=("cat",))  # seen, never prompted: no row
    got = (await client.get("/tags/detail", params={"tag": "any:cat"})).json()
    assert got["weights"] == {
        "min": 0.8,
        "max": 1.2,
        "mode": 1.2,
        "weighted": 3,
        "prompted": 4,
    }


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
    monkeypatch.setattr(tag_categories, "load", _chars("frieren"))
    seed("L1:a", tags=("prompt:frieren", "prompt:cat"))
    got = (await client.get("/tags/characters")).json()
    assert [(c["tag"], c["count"]) for c in got] == [("frieren", 1)]
    assert got[0]["thumb_url"].split("?")[0].endswith("/images/L1%3Aa/thumb")


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


async def test_bare_names_need_the_library_behind_them(client, seed, monkeypatch):
    monkeypatch.setattr(
        tag_categories,
        "load",
        _chars(furina="genshin_impact", sunny="omori", white_rabbit="alice"),
    )
    seed("L1:a", tags=("prompt:furina", "prompt:genshin_impact"))
    # the AI's full name backs it too
    seed("L1:b", tags=("prompt:furina", "furina_(genshin_impact)"))
    seed("L1:c", tags=("prompt:furina",))
    seed("L1:d", tags=("prompt:sunny", "prompt:beach"))
    seed("L1:e", tags=("prompt:white_rabbit",))
    cats = {r["tag"]: r["category"] for r in (await client.get("/tags/browse")).json()}
    assert cats["furina"] == "character"
    assert cats["sunny"] == "general"
    assert cats["white_rabbit"] == "general"
    detail = (await client.get("/tags/detail", params={"tag": "furina"})).json()
    assert detail["category"] == "character"


async def test_quarantined_images_dont_back_a_bare_name(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars(furina="genshin_impact"))
    seed("L1:a", tags=("prompt:furina",))
    seed("L1:b", tags=("prompt:furina", "prompt:genshin_impact"), quarantined=True)
    seed("L1:c", tags=("prompt:furina", "prompt:genshin_impact"), quarantined=True)
    cats = {r["tag"]: r["category"] for r in (await client.get("/tags/browse")).json()}
    assert cats["furina"] == "general"


async def test_tags_sharing_images_get_different_covers(client, seed):
    names = [f"tag_{c}" for c in "abcdefghijklmnop"]
    for i in range(40):
        seed(f"L1:{i:02}", tags=tuple(names))

    covers = {
        r["tag"]: r["thumb_image_id"] for r in (await client.get("/tags/browse")).json()
    }
    # One shared cover for every tag was the bug; a fair shuffle spreads them.
    assert len(set(covers.values())) >= 8
    for name in names[:4]:
        got = (await client.get(f"/tags/samples?tags=any:{name}&per=4")).json()
        assert got[f"any:{name}"][0]["_id"] == covers[name]


async def test_a_tags_cover_can_be_centred(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars())
    seed("L1:a", tags=("cat",), width=200, height=100)

    detail = (await client.get("/tags/detail", params={"tag": "cat"})).json()
    assert detail["focus"] is None
    assert detail["cover_url"] and detail["aspect"] == 2

    r = await client.put(
        "/tags/focus", params={"tag": "cat"}, json={"focus_x": 0.25, "focus_y": 0.75}
    )
    assert r.json()["focus"] == [0.25, 0.75]
    assert (await client.get("/tags/detail", params={"tag": "cat"})).json()[
        "focus"
    ] == [0.25, 0.75]
    row = next(
        x for x in (await client.get("/tags/browse")).json() if x["tag"] == "cat"
    )
    assert row["focus"] == [0.25, 0.75]
    # The tag page (served like a character page) frames its cover the same.
    page = (await client.get("/tags/character", params={"tag": "cat"})).json()
    assert page["category"] != "character"
    assert page["focus"] == [0.25, 0.75]

    # Pinning another image drops the point: it was for the old cover.
    seed("L1:b", tags=("cat",), width=100, height=100)
    await client.post("/tags/thumbnail/cat", json={"image_id": "L1:b"})
    assert (await client.get("/tags/detail", params={"tag": "cat"})).json()[
        "focus"
    ] is None
    await client.delete("/tags/thumbnail/cat")

    assert (
        await client.put(
            "/tags/focus", params={"tag": "cat"}, json={"focus_x": 2, "focus_y": 0}
        )
    ).status_code == 422
    await client.put(
        "/tags/focus", params={"tag": "cat"}, json={"focus_x": "", "focus_y": ""}
    )
    assert (await client.get("/tags/detail", params={"tag": "cat"})).json()[
        "focus"
    ] is None


async def test_focus_lands_on_the_cover_the_panel_shows(client, seed, monkeypatch):
    monkeypatch.setattr(tag_categories, "load", _chars())
    focus = {"focus_x": 0.5, "focus_y": 0.1}
    r = await client.put("/tags/focus", params={"tag": "nope"}, json=focus)
    assert r.status_code == 404

    seed("L1:a", tags=("cat",))
    seed("L1:b", tags=("cat",))
    await client.post("/tags/thumbnail/cat", json={"image_id": "L1:b"})
    await client.put("/tags/focus", params={"tag": "cat"}, json=focus)
    detail = (await client.get("/tags/detail", params={"tag": "cat"})).json()
    assert detail["cover_image_id"] == "L1:b"
    assert detail["focus"] == [0.5, 0.1]

    # Only hidden images carry it: no cover to centre.
    seed("L1:q", tags=("dog",), quarantined=True)
    r = await client.put("/tags/focus", params={"tag": "dog"}, json=focus)
    assert r.status_code == 404
