"""The prompt board: which part of a scene each prompt tag sets.

Generate's Prompt reads as a board of sections (Subject, Hair, Eyes,
Expression, ... Background, Lighting, Style), so a tag that pulls a picture
the wrong way, or a part left unsaid, is easy to see. A tag's section comes
from the tag-group list through :mod:`attire`'s facets (look, outfit, pose,
scene, framing), split finer by group, and from Danbooru's tag list
(:mod:`danbooru_tags`): its category (characters, artists, meta) and its
aliases. A name in neither list is **unknown**, which on the board is the
place to look first: a typo, or a word the model has never seen. One the
library's images already carry is **library** instead: not Danbooru's, but
a word in use (`adult`, `pinup`).

Pure apart from the inputs the caller loads: the Danbooru list, the
tagger's character names and the library's tag names.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from . import attire
from .danbooru_tags import ARTIST, CHARACTER, COPYRIGHT, META, TagList

SECTIONS = (
    "subject",
    "hair",
    "eyes",
    "expression",
    "body",
    "attire",
    "pose",
    "framing",
    "background",
    "lighting",
    "style",
    "other",
    "quality",
    "library",
    "unknown",
)

_HAIR = frozenset({"hair", "hair_color", "hair_styles"})
_SUBJECT = frozenset({"character_count", "focus_tags", "groups"})
_STYLE = frozenset(
    {"visual_aesthetic", "artistic_license", "colors", "year_tags", "fine_art_parody"}
)
_POSE = frozenset({"sex_acts", "sexual_positions", "simulated_sex_acts"})
# Who and how many: the count tags. The groups file much else beside them
# (`comic`, `pov`, `doll`, `ass_focus`), which goes by its other groups.
_COUNT = re.compile(
    r"^(solo|solo_focus|no_humans|(\d+\+?|multiple_)(girls?|boys?|others?)|(male|female|other)_focus)$"
)
# Tags the groups file somewhere a prompt doesn't mean them.
OVERRIDES = {
    "portrait": "framing",
    "profile": "framing",
    "upper_body": "framing",
    "outdoors": "background",
    "indoors": "background",
    "scenery": "background",
    # Builds the groups file under sex acts: how a body looks, not what it does.
    "muscular": "body",
    "muscular_male": "body",
    "muscular_female": "body",
    "toned": "body",
    "toned_male": "body",
    "toned_female": "body",
    "curvy": "body",
    "plump": "body",
    "fat": "body",
    "fat_man": "body",
    "skinny": "body",
    "petite": "body",
    "mature_female": "body",
    "mature_male": "body",
    "old_man": "body",
    "old_woman": "body",
    "pregnant": "body",
    "big_belly": "body",
    "minigirl": "body",
    "miniboy": "body",
    "giant": "body",
    "giantess": "body",
}
# Unlisted names that still say where (`night_sky`, `simple_background`).
_PLACE_WORDS = re.compile(
    r"(^|_)(background|sky|scenery|clouds?|horizon|sunset|sunrise|room|street)$"
)


def _section(
    tag: str, entry, category: int | None, characters: frozenset[str]
) -> str | None:
    if tag in OVERRIDES:
        return OVERRIDES[tag]
    if tag in characters or category in (CHARACTER, COPYRIGHT):
        return "subject"
    if category == ARTIST:
        return "style"
    if category == META:
        return "quality"
    if tag in attire.EYE_STATES or (entry and entry[1] == "face_tags"):
        return "expression"
    groups = attire._groups(entry) if entry else set()
    # Holding something is a pose, wherever the thing is filed
    # (`holding_flower` sits under flowers); where one looks is the eyes.
    if "holding_tags" in groups:
        return "pose"
    if (
        entry
        and entry[1] == "eyes_tags"
        and not attire.is_identity(tag)
        and tag.startswith("looking_")
    ):
        return "eyes"
    facet = attire._facet(tag, entry)
    if facet == "look":
        if groups & _HAIR or tag.endswith("_hair"):
            return "hair"
        if "eyes_tags" in groups or tag.endswith(("_eyes", "_pupils")):
            return "eyes"
        return "body"
    if facet == "outfit":
        return "attire"
    if facet == "pose":
        return "pose"
    if facet == "framing":
        if _COUNT.match(tag):
            return "subject"
        if entry and entry[1] in _SUBJECT:
            also = entry[2]
            # `ass_focus` frames the picture; `penis` is a body part.
            if entry[1] == "focus_tags" or any(
                g.endswith("/image_composition") for g in also
            ):
                return "framing"
            if any(g.startswith("body/") for g in also):
                return "body"
            return "other"
        return "framing"
    if facet == "scene":
        return "lighting" if entry and entry[1] == "lighting" else "background"
    if entry:
        if groups & _STYLE:
            return "style"
        # A body part first: `pectorals` is also listed under sex acts.
        if entry[0] == "body":
            return "body"
        if groups & _POSE:
            return "pose"
        return "other"
    if _PLACE_WORDS.search(tag):
        return "background"
    return None


def place(
    name: str,
    tags: TagList,
    characters: frozenset[str],
    library: frozenset[str] = frozenset(),
) -> dict:
    """Where one prompt tag goes, and what the lists know of it. An alias is
    placed as its tag (``alias_of``). ``library``: the library's tag names
    (unprefixed), which turn an unknown name into a library one."""
    key = attire._key(name)
    tag = tags.resolve(key)
    entry = attire._load().get(tag)
    known = tags.tags.get(tag)
    section = _section(tag, entry, known[0] if known else None, characters)
    if section is None and entry is None:
        # Unlisted: placed as its last words (`sunflower_field` as `field`).
        words = tag.split("_")
        for i in range(1, len(words)):
            tail = "_".join(words[i:])
            if (e := attire._load().get(tail)) and (
                section := _section(tail, e, None, frozenset())
            ):
                break
    if section is None:
        listed = entry is not None or known is not None or tag in characters
        # Without the Danbooru list nothing can be called unknown.
        if listed or not tags.tags:
            section = "other"
        else:
            section = "library" if tag in library or key in library else "unknown"
    out: dict = {"section": section}
    if tag != key:
        out["alias_of"] = tag
    if entry:
        out["group"] = attire.group_of(tag) or entry[1]
        out["category"] = entry[0]
        if entry[2]:
            out["also"] = list(entry[2])
    if known:
        out["posts"] = known[1]
    return out


def place_all(
    names: Iterable[str],
    tags: TagList,
    characters: frozenset[str],
    library: frozenset[str] = frozenset(),
) -> dict[str, dict]:
    return {n: place(n, tags, characters, library) for n in dict.fromkeys(names)}


# How many of the most posted tags each section offers, beside the library's.
OFFER = 400


def offers(
    names: Iterable[str],
    tags: TagList,
    characters: frozenset[str],
    library: Iterable[str] = (),
) -> dict[str, list[list]]:
    """``section -> [[tag, posts], ...]``: what each section can suggest. The
    listed tags and ``names`` (the tagger's vocabulary), the most posted
    first and capped at :data:`OFFER`, plus every library tag the lists place
    in a section (a stray prompt word in "other" is left out). Characters,
    quality and unknown names are left out: the Character layer and the
    boilerplate list have those."""
    out: dict[str, dict[str, int]] = {}
    pool = dict.fromkeys([*attire._load(), *(attire._key(n) for n in names)])
    for n in pool:
        p = place(n, tags, characters)
        if "alias_of" in p:
            continue
        out.setdefault(p["section"], {})[n] = p.get("posts", 0)
    for k, v in out.items():
        out[k] = dict(sorted(v.items(), key=lambda kv: -kv[1])[:OFFER])
    for n in library:
        key = attire._key(n)
        p = place(key, tags, characters)
        # Only what the lists can place: not every stray prompt word.
        if (
            "alias_of" not in p
            and p["section"] not in ("other", "library", "unknown")
            and key not in characters
            and tags.tags.get(key, (None,))[0] not in (CHARACTER, COPYRIGHT)
        ):
            out.setdefault(p["section"], {})[key] = p.get("posts", 0)
    skip = {"quality", "library", "unknown"}
    return {
        k: [[n, posts] for n, posts in sorted(v.items(), key=lambda kv: -kv[1])]
        for k, v in out.items()
        if k not in skip and k in SECTIONS
    }
