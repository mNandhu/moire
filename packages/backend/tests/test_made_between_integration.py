"""Images made within a time range: the gallery's made_from / made_to (a day
of the Overview calendar) and the characters those images show (Overview's
session titles and its month of characters)."""

from moire.services.tags import categories as tag_categories

DAY = 86400
T0 = 1_800_000_000


async def _ids(client, **params):
    resp = await client.get("/images", params=params)
    assert resp.status_code == 200, resp.text
    return sorted(r["_id"] for r in resp.json())


async def test_made_range_keeps_images_made_within_it(client, seed):
    seed("L1:before", mtime=T0 - 1)
    seed("L1:start", mtime=T0)
    seed("L1:late", mtime=T0 + DAY - 1)
    seed("L1:next", mtime=T0 + DAY)
    assert await _ids(client, made_from=T0, made_to=T0 + DAY) == [
        "L1:late",
        "L1:start",
    ]
    assert await _ids(client, made_from=T0 + DAY) == ["L1:next"]
    assert await _ids(client, made_to=T0) == ["L1:before"]
    bad = await client.get("/images", params={"made_from": T0, "made_to": T0})
    assert bad.status_code == 422


async def test_characters_made_counts_images_in_the_range(client, seed, monkeypatch):
    async def vocab():
        return tag_categories.Vocab(
            frozenset({"furina_(genshin_impact)", "nahida"}),
            {
                "furina": tag_categories.Candidate(
                    "genshin_impact", "furina_(genshin_impact)"
                )
            },
        )

    monkeypatch.setattr(tag_categories, "load", vocab)
    seed("L1:a", tags=("furina_(genshin_impact)",), mtime=T0 + 10)
    # A bare alias from the prompt counts for the full name.
    seed("L1:b", tags=("prompt:furina", "furina_(genshin_impact)"), mtime=T0 + 20)
    seed("L1:c", tags=("prompt:furina",), mtime=T0 + 30)
    seed("L1:d", tags=("nahida",), mtime=T0 + 40)
    seed("L1:old", tags=("nahida",), mtime=T0 - DAY)
    seed("L1:hidden", tags=("nahida",), mtime=T0 + 50, quarantined=True)

    got = await client.get("/tags/characters/made", params={"since": T0})
    assert got.json() == [
        {"tag": "furina_(genshin_impact)", "count": 3},
        {"tag": "nahida", "count": 1},
    ]
    one = await client.get(
        "/tags/characters/made", params={"since": T0, "until": T0 + 25, "limit": 5}
    )
    assert one.json() == [{"tag": "furina_(genshin_impact)", "count": 2}]
    with_ids = await client.get(
        "/tags/characters/made", params={"since": T0, "until": T0 + 25, "ids": 1}
    )
    assert with_ids.json() == [
        {"tag": "furina_(genshin_impact)", "count": 2, "image_ids": ["L1:a", "L1:b"]}
    ]
    bad = await client.get("/tags/characters/made", params={"since": T0, "until": T0})
    assert bad.status_code == 422
