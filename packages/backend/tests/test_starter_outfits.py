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


def _backdrop(o: dict) -> list[str]:
    return [x.strip() for x in o["backdrop"].split(",") if x.strip()]


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


def test_wearer_has_one_subject_and_known_tags():
    for o in OUTFITS:
        subjects = [x for x in o["wearer"] if x in ("1girl", "1boy")]
        assert len(subjects) == 1, o["id"]
        for tag in [*o["wearer"], *_backdrop(o)]:
            assert canonical_name(tag) == tag, (o["id"], tag)
            # Listed, so the model knows it; not attire, so it can't dress the cover.
            assert attire.tag_key(tag) in attire.entries(), (o["id"], tag)
            assert not attire.is_attire(tag), (o["id"], tag)


def test_every_cover_prompt_is_general():
    # The covers are made on a ComfyUI that may be public, and ship to everyone.
    for o in OUTFITS:
        assert not sensitivity.tag_level([*o["wearer"], *o["tags"], *_backdrop(o)]), o[
            "id"
        ]


def test_covers_match_outfits():
    ids = {o["id"] for o in OUTFITS}
    covers = {p.stem for p in COVERS.glob("*.webp")} if COVERS.exists() else set()
    assert covers <= ids, f"covers for unlisted outfits: {sorted(covers - ids)}"
