"""The attire list: which general tags name something worn.

The WD tagger has no clothing category, so Moiré ships a tag-group list built
from Danbooru's ``tag_groups`` wiki hub (``scripts/build_tag_groups.py``),
limited to the tagger's vocabulary and committed as ``data/tag_groups.json``.
Each tag keeps its top-level category (body, sex, ...) and the group it came
from (headwear, legwear, ...), plus ``also``: its other places, since Danbooru
lists a tag in several pages. Attire is a set of groups (``ATTIRE_GROUPS``),
not one category, because the clothing category also holds nudity and makeup
tags and neckwear sits under body. The file is hand-editable; the loader
reads it once and caches it.

Pure and dependency-free. Takes bare tag names (no ``manual:`` / ``prompt:``
prefix); spelling goes through :func:`tag_names.canonical_name`, lowercased,
since the list is stored in the tagger's own lowercase underscore form.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path

from .tag_names import canonical_name

TAG_GROUPS_PATH = Path(__file__).resolve().parents[1] / "data" / "tag_groups.json"
# Groups whose tags are things worn. A tag is attire when any of its places is
# one of these.
ATTIRE_GROUPS = frozenset(
    {
        "accessories",
        "attire",
        "eyewear",
        "fashion_style",
        "handwear",
        "headwear",
        "legwear",
        "neck_and_neckwear",
        "sexual_attire",
        "sleeves",
    }
)

# Groups whose tags describe the body itself: what stays when a character
# changes clothes, pose or scene (expressions, nudity and posture don't).
IDENTITY_GROUPS = frozenset(
    {
        "breasts_tags",
        "ears_tags",
        "eyes_tags",
        "hair",
        "hair_color",
        "hair_styles",
        "skin_color",
        "wings",
    }
)

# Unlisted tags that still name a body feature.
_BODY_WORDS = re.compile(
    r"_(hair|eyes|pupils|sclera|ears|horns?|tail|wings|skin|bangs|eyebrows|eyelashes)$"
    r"|^(halo|horns|freckles|mole|scar|heterochromia|ahoge|fang|fangs)"
)
# Kemonomimi the groups don't list (`fox_girl`, `wolf_boy`).
_ANIMAL_PERSON = re.compile(
    r"^(bear|bird|cow|deer|dog|dragon|fox|horse|lion|monkey|mouse|"
    r"rabbit|raccoon|shark|sheep|snake|squirrel|tiger|wolf)_(girl|boy)$"
)

# Poses and actions that the attire groups list because they involve clothing
# (`adjusting_scarf`, `towel_around_neck`, `hand_on_headwear`), not garments.
_NOT_WORN = re.compile(
    r"^(adjusting|holding|kissing)_|_around_neck$|_grab$|^hands?_(on|in)_"
    r"|^(long_neck|hand_fan|hand_tattoo)$"
)


# From the nudity group, the tags that say how a garment is cut or worn
# (`midriff`, `off_shoulder`, `shoulder_cutout`): part of an outfit, in the
# "exposure" group. A list, not a pattern: the group also holds actions
# (`skirt_lift`), nudity and underwear states (`open_bra`, `crotch_cutout`),
# which never belong in an outfit.
EXPOSURE_GROUP = "exposure"
EXPOSURE_TAGS = frozenset(
    {
        "armpit_cutout",
        "back_cutout",
        "backless_outfit",
        "bare_arms",
        "bare_back",
        "bare_legs",
        "bare_shoulders",
        "barefoot",
        "center_opening",
        "cleavage",
        "cleavage_cutout",
        "hip_vent",
        "low-cut_armhole",
        "midriff",
        "navel_cutout",
        "off_shoulder",
        "open_coat",
        "open_collar",
        "open_hoodie",
        "open_jacket",
        "open_vest",
        "shoulder_cutout",
        "side_cutout",
        "side_slit",
        "sleeveless",
        "sleeves_pushed_up",
        "sleeves_rolled_up",
        "stomach_cutout",
        "thigh_cutout",
        "zettai_ryouiki",
    }
)


# Attire hub tags the groups don't list (Danbooru files them as hubs, not
# group members), with the group they'd sit in.
UNLISTED_ATTIRE = {"jewelry": "accessories", "strapless": "exposure"}

# A colour or print in front of a garment (`red_bikini`, `white_shirt`,
# `striped_thighhighs`): Danbooru tags these but the groups list only the
# garment, so the tag counts as the garment's group. Hubs the groups leave
# out (`black_footwear`) are named here.
_COLOURED = re.compile(
    r"^(?:(?:light|dark|pale)_)?"
    r"(red|blue|green|yellow|orange|purple|pink|black|white|grey|gray|brown|"
    r"aqua|beige|silver|gold|multicolored|two-tone|see-through|striped|plaid|"
    r"polka_dot|checkered|camouflage|floral_print|leopard_print|frilled)_(.+)$"
)
_GARMENT_HUBS = {
    "footwear": "attire",
    "headwear": "headwear",
    "legwear": "legwear",
    "neckwear": "neck_and_neckwear",
    "one-piece_swimsuit": "attire",
}


def _key(tag: str) -> str:
    return canonical_name(tag).lower()


def _coloured_group(key: str) -> str | None:
    """The attire group of an unlisted coloured garment, else None."""
    m = _COLOURED.match(key)
    if not m:
        return None
    garment = m.group(2)
    entry = _load().get(garment)
    if entry is None:
        return _GARMENT_HUBS.get(garment) or UNLISTED_ATTIRE.get(garment)
    group = _attire_group(garment, entry)
    # A coloured exposure tag isn't a thing (`red_midriff`).
    return group if group != EXPOSURE_GROUP else None


def _unlisted_group(key: str) -> str | None:
    """An attire tag the groups don't list: a hub, or a coloured garment.
    Only beside a loaded list, like everything else here."""
    if not _load():
        return None
    return UNLISTED_ATTIRE.get(key) or _coloured_group(key)


def parse(doc: object) -> dict[str, tuple[str, str, tuple[str, ...]]]:
    """The ``tag -> (category, group, also)`` map of a tag-group document, keys
    normalised. Malformed input yields an empty map (or skips the entry)
    rather than raising: a broken hand edit must not take the app down."""
    tags = doc.get("tags") if isinstance(doc, dict) else None
    if not isinstance(tags, dict):
        return {}
    out: dict[str, tuple[str, str, tuple[str, ...]]] = {}
    for name, info in tags.items():
        if not (isinstance(name, str) and name.strip() and isinstance(info, dict)):
            continue
        category, group, also = (
            info.get("category"),
            info.get("group"),
            info.get("also", []),
        )
        if not (isinstance(category, str) and isinstance(group, str)):
            continue
        if not (isinstance(also, list) and all(isinstance(a, str) for a in also)):
            also = []
        out[_key(name)] = (category, group, tuple(also))
    return out


@lru_cache(maxsize=1)
def _load() -> dict[str, tuple[str, str, tuple[str, ...]]]:
    try:
        return parse(json.loads(TAG_GROUPS_PATH.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {}


def _groups(entry: tuple[str, str, tuple[str, ...]]) -> set[str]:
    return {entry[1], *(a.rpartition("/")[2] for a in entry[2])}


def _attire_group(tag: str, entry: tuple[str, str, tuple[str, ...]]) -> str | None:
    groups = _groups(entry) & ATTIRE_GROUPS
    if not groups and "nudity" in _groups(entry):
        return EXPOSURE_GROUP if tag in EXPOSURE_TAGS else None
    if not groups or _NOT_WORN.search(tag):
        return None
    return entry[1] if entry[1] in groups else min(groups)


# Eye tags that say what the eyes are doing, not what they're like.
EYE_STATES = frozenset(
    {
        "closed_eyes",
        "half-closed_eyes",
        "one_eye_closed",
        "narrowed_eyes",
        "wide-eyed",
        "rolling_eyes",
        "sparkling_eyes",
        "empty_eyes",
        "crazy_eyes",
        "tearing_up",
    }
)


def is_attire(tag: str) -> bool:
    key = _key(tag)
    entry = _load().get(key)
    if entry is None:
        return _unlisted_group(key) is not None
    return _attire_group(key, entry) is not None


def is_identity(tag: str) -> bool:
    """A body-feature tag (hair, eyes, ears, ...). An unlisted tag counts when
    its name says so (``halo``, ``mole_under_eye``, ``x_pupils``); from the
    breasts group only the sizes do. Never attire."""
    key = _key(tag)
    # A passing eye state: how they look in one picture, not who they are.
    if key in EYE_STATES:
        return False
    entry = _load().get(key)
    if entry is None:
        return bool(_BODY_WORDS.search(key))
    if _attire_group(key, entry) is not None or key.startswith("looking_"):
        return False
    # An expression, though also listed with eyes (`@_@`, `closed_eyes`).
    if entry[1] == "face_tags":
        return False
    groups = _groups(entry) & IDENTITY_GROUPS
    if groups == {"breasts_tags"}:
        return key.endswith("breasts") or key == "flat_chest"
    return bool(groups)


def group_of(tag: str) -> str | None:
    """The group of a listed tag, ``None`` when it is unlisted. An attire tag
    answers with its attire group (``bikini`` is attire, not ``water``);
    others with their most specific group."""
    key = _key(tag)
    entry = _load().get(key)
    if entry is None:
        return _unlisted_group(key)
    return _attire_group(key, entry) or entry[1]


def category_of(tag: str) -> str | None:
    """The primary top-level category (body, sex, ...) of a listed tag."""
    entry = _load().get(_key(tag))
    return entry[0] if entry else None


def all_tags(category: str | None = None) -> dict[str, str]:
    """``tag -> group`` for every listed tag, or only one primary category's."""
    return {
        t: group_of(t) or e[1] for t, e in _load().items() if category in (None, e[0])
    }


def coloured(names: Iterable[str]) -> dict[str, str]:
    """``tag -> attire group`` for the unlisted coloured garments among
    ``names`` (the tagger's vocabulary): the lists below can't enumerate
    them from the groups alone."""
    listed = _load()
    out: dict[str, str] = {}
    for name in names:
        key = _key(name)
        if key not in listed and (group := _unlisted_group(key)):
            out[key] = group
    return out


def attire_tags(extra: Iterable[str] = ()) -> dict[str, str]:
    """``tag -> attire group`` for every attire tag; ``extra`` names (the
    tagger's vocabulary) add the coloured garments among them."""
    out: dict[str, str] = {}
    listed = _load()
    for tag, entry in listed.items():
        group = _attire_group(tag, entry)
        if group:
            out[tag] = group
    if listed:
        out.update({t: g for t, g in UNLISTED_ATTIRE.items() if t not in listed})
        out.update(coloured(extra))
    return out


# -- Facets: the coarse kind of thing a tag describes -------------------------
#
# The image view tints each tag by its facet, so an image's tags read as
# groups (how the character looks, what they wear, what they're doing, where,
# how it's framed) without sorting them. Look and outfit are the identity and
# attire tests above; the rest come from these tag groups. A tag in none of
# them gets no facet and no tint.
FACET_GROUPS: dict[str, frozenset[str]] = {
    "pose": frozenset(
        {
            "dances",
            "face_tags",
            "gestures",
            "hands",
            "holding_tags",
            "posture",
            "verbs_and_gerunds",
        }
    ),
    "scene": frozenset(
        {
            "backgrounds",
            "fire",
            "flowers",
            "holidays_and_celebrations",
            "lighting",
            "locations",
            "plants",
            "real_world_locations",
            "water",
        }
    ),
    "framing": frozenset(
        {"character_count", "focus_tags", "groups", "image_composition"}
    ),
}
FACETS = ("look", "outfit", "pose", "scene", "framing")


def _facet(key: str, entry: tuple[str, str, tuple[str, ...]] | None) -> str | None:
    if key in EYE_STATES:
        return "pose"
    if entry is None:
        if _unlisted_group(key):
            return "outfit"
        return "look" if _BODY_WORDS.search(key) or _ANIMAL_PERSON.match(key) else None
    # Animal traits the groups file beside animals and body parts: `cat_girl`,
    # `demon_boy`, `tail`.
    if key == "tail" or (entry[0] == "creatures" and key.endswith(("_girl", "_boy"))):
        return "look"
    if _attire_group(key, entry) is not None:
        return "outfit"
    if is_identity(key):
        return "look"
    groups = _groups(entry)
    # The primary group decides first, so `holding_umbrella` (holding, also
    # listed under rain) is a pose.
    for facet, members in FACET_GROUPS.items():
        if entry[1] in members:
            return facet
    for facet, members in FACET_GROUPS.items():
        if groups & members:
            return facet
    return None


def facet_of(tag: str) -> str | None:
    """The facet (one of :data:`FACETS`) of a tag, or ``None``."""
    key = _key(tag)
    return _facet(key, _load().get(key))


_facets_cache: tuple[dict, dict[str, str]] | None = None


def facets(extra: Iterable[str] = ()) -> dict[str, str]:
    """``tag -> facet`` for every *listed* tag that has one (an unlisted tag
    that only :func:`facet_of`'s body-word rule would place is left out).
    Rebuilt whenever the list itself is reloaded."""
    global _facets_cache
    listed = _load()
    if _facets_cache is None or _facets_cache[0] is not listed:
        out = {t: f for t, e in listed.items() if (f := _facet(t, e))}
        if listed:
            out.update({t: "outfit" for t in UNLISTED_ATTIRE if t not in listed})
        _facets_cache = (listed, out)
    added = {t: "outfit" for t in coloured(extra)}
    return {**_facets_cache[1], **added} if added else _facets_cache[1]
