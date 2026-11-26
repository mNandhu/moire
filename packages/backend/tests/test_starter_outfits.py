"""The shipped starter outfits: attire only, general level, one cover each."""

from __future__ import annotations

import json
import re
from pathlib import Path

from moire.services.characters import attire, outfits
from moire.services.tags import sensitivity
from moire.services.tags.names import canonical_name

DATA = Path(outfits.__file__).resolve().parents[2] / "data"
OUTFITS = json.loads((DATA / "starter_outfits.json").read_text(encoding="utf-8"))[
    "outfits"
]
COVERS = DATA / "starter_outfits"
CATEGORIES = {
    "school", "work", "formal", "casual", "traditional",
    "fantasy", "sports", "seasonal", "street", "historical",
}  # fmt: skip


def _cover_tags(o: dict) -> list[str]:
    c = o["cover"]
    return [c["subject"], *c["character"], *c["moment"], *c.get("avoid", [])]


def test_ids_unique_and_stable_shape():
    ids = [o["id"] for o in OUTFITS]
    assert len(ids) == len(set(ids))
    assert 60 <= len(ids) <= 80
    for o in OUTFITS:
        assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", o["id"]), o["id"]
        assert o["category"] in CATEGORIES, o["id"]
        assert 1 <= len(o["name"]) <= 80 and "—" not in o["name"], o["id"]


def test_tags_are_attire_and_fit_an_outfit():
    for o in OUTFITS:
        assert 1 <= len(o["tags"]) <= outfits.MAX_TAGS, o["id"]
        assert outfits.clean_tags(o["tags"]) == o["tags"], o["id"]
        for tag in o["tags"]:
            assert attire.is_attire(tag), (o["id"], tag)


def test_cover_is_one_character_in_a_moment():
    characters = [o["cover"]["character"][0] for o in OUTFITS]
    assert len(characters) == len(set(characters)), "a character covers two outfits"
    for o in OUTFITS:
        c = o["cover"]
        assert c["subject"] in ("1girl", "1boy"), o["id"]
        assert 1 <= len(c["character"]) <= 2, o["id"]
        assert 4 <= len(c["moment"]) <= 14, o["id"]
        for tag in _cover_tags(o):
            assert canonical_name(tag) == tag, (o["id"], tag)
        # The moment sets the scene; it never dresses the cover.
        for tag in c["moment"]:
            assert not attire.is_attire(tag), (o["id"], tag)
        assert not set(c.get("avoid", [])) & set(o["tags"]), o["id"]


def test_every_cover_prompt_is_general():
    # The covers are made on a ComfyUI that may be public, and ship to everyone.
    for o in OUTFITS:
        assert not sensitivity.tag_level([*o["tags"], *_cover_tags(o)]), o["id"]


def test_covers_match_outfits():
    ids = {o["id"] for o in OUTFITS}
    covers = {p.stem for p in COVERS.glob("*.webp")} if COVERS.exists() else set()
    assert covers <= ids, f"covers for unlisted outfits: {sorted(covers - ids)}"


def test_no_low_angle_under_a_skirt():
    # A cover shot from below on a skirt or dress can look up it; those
    # covers ship to everyone.
    # By a tag's last word: a dress_shirt is no dress.
    hems = {"skirt", "dress", "gown", "kimono", "yukata", "hakama", "robe", "lolita"}
    for o in OUTFITS:
        if "from_below" in o["cover"]["moment"]:
            assert not any(t.split("_")[-1] in hems for t in o["tags"]), o["id"]


# -- In the app ------------------------------------------------------------------

import asyncio  # noqa: E402

from moire.services.characters import starters  # noqa: E402
from moire.services.tags import categories as tag_categories  # noqa: E402
from tests.test_characters import _chars  # noqa: E402
from tests.test_generate_integration import comfy, make_ready  # noqa: E402,F401
from tests.test_recipes import _library  # noqa: E402

HU = "hu_tao_(genshin_impact)"
MAID = [
    "maid", "maid_headdress", "dress", "apron",
    "puffy_short_sleeves", "frills", "thighhighs", "mary_janes",
]  # fmt: skip


def test_every_listed_starter_has_its_cover():
    listed = starters.entries()
    assert len(listed) == len(OUTFITS)
    assert all(s.cover_version for s in listed.values())
    # Only a listed id names a file: nothing else becomes a path.
    assert starters.cover_path("../starter_outfits") is None
    assert starters.find("starter:maid-dress").tags == tuple(MAID)


async def test_starters_in_the_app(client, comfy, seed, monkeypatch):  # noqa: F811
    listed = (await client.get("/generate/outfits/starters")).json()
    assert len(listed) == len(OUTFITS)
    maid = next(o for o in listed if o["_id"] == "starter:maid-dress")
    assert maid["starter"] is True and maid["category"] == "work"
    assert [x["tag"] for x in maid["tags"]] == MAID
    cover = maid["thumb_url"]
    assert cover.startswith("/api/v1/generate/outfits/starters/maid-dress/cover?v=")

    path = cover.removeprefix("/api/v1")
    got = await client.get(path)
    assert got.status_code == 200 and got.headers["content-type"] == "image/webp"
    assert "immutable" in got.headers["cache-control"]
    head = await client.head(path)
    assert head.status_code == 200 and not head.content
    assert head.headers["content-length"] == str(len(got.content))
    assert head.headers["etag"] == got.headers["etag"]
    assert head.headers["last-modified"] == got.headers["last-modified"]
    assert (
        await client.get("/generate/outfits/starters/nope/cover")
    ).status_code == 404

    # For a character, their best image wearing it takes over the cover:
    # never a quarantined one, whatever its score.
    monkeypatch.setattr(tag_categories, "load", _chars(HU, hu_tao="genshin_impact"))
    await asyncio.to_thread(_library, seed)
    seed("L1:maid", tags=(HU, *MAID[:6]), score=3)
    seed("L1:maid_more", tags=(HU, *MAID), score=1)
    seed("L1:maid_hidden", tags=(HU, *MAID), score=5, quarantined=True)
    seed("L1:maid_few", tags=(HU, *MAID[:5]), score=5)
    seed("L1:other", tags=("someone_else", *MAID), score=5)
    mine = (
        await client.get("/generate/outfits/starters", params={"character": HU})
    ).json()
    maid = next(o for o in mine if o["_id"] == "starter:maid-dress")
    assert maid["image_id"] == "L1:maid_more"
    assert "/images/L1%3Amaid_more/thumb?v=" in maid["thumb_url"]
    # One they don't wear keeps the shipped cover.
    gown = next(o for o in mine if o["_id"] == "starter:evening-gown")
    assert (
        gown["image_id"] is None and "/starters/evening-gown/cover" in gown["thumb_url"]
    )
    # A character the library doesn't know yet still gets every starter.
    new = await client.get("/generate/outfits/starters", params={"character": "nobody"})
    assert new.status_code == 200 and len(new.json()) == len(listed)
    assert all(o["image_id"] is None for o in new.json())

    # The gallery's outfit filter takes a starter.
    feed = (
        await client.get(
            "/images", params={"outfit": "starter:maid-dress", "limit": 50}
        )
    ).json()
    assert {i["_id"] for i in feed} >= {"L1:maid", "L1:maid_more", "L1:other"}
    assert "L1:maid_few" not in {i["_id"] for i in feed}

    # Worn in a batch as it is, recorded by its id.
    await make_ready(client, comfy, seed)
    body = {
        "positive": [{"kind": "character"}],
        "characters": [
            {
                "tag": HU,
                "label": "Hu Tao",
                "tags": [HU],
                "outfit": {
                    "id": "starter:maid-dress",
                    "name": "Maid dress",
                    "tags": MAID,
                },
            }
        ],
        "count": 1,
    }
    res = await client.post("/generate/batches", json=body)
    assert res.status_code == 200, res.text
    assert res.json()["name"] == "Hu Tao, Maid dress"
    got = (await client.get(f"/generate/batches/{res.json()['_id']}")).json()
    assert got["inputs"]["characters"][0]["outfit"]["id"] == "starter:maid-dress"
