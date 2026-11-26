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
