"""The attire list: which general tags name something worn.

The WD tagger has no clothing category, so Moiré ships a tag-group list built
from Danbooru's ``tag_groups`` wiki hub (``scripts/build_tag_groups.py``),
limited to the tagger's vocabulary and committed as ``data/tag_groups.json``.
Each tag keeps its top-level category (body, attire, ...) and the group it
came from (headwear, legwear, ...), plus ``also``: its other places, since
Danbooru lists a tag in several pages. Attire is a set of groups
(``ATTIRE_GROUPS``), not one category, because the clothing category also
holds bare-skin and makeup tags and neckwear sits under body. The file is
hand-editable; the loader reads it once and caches it.

Danbooru's adult groups are stored under neutral names
(:data:`GROUP_RENAMES`), and the entries of tags that have a sensitivity level
are keyed by :func:`tag_hash.hash_tag` under ``hashed`` (:func:`hide_entry`):
they are found by name as any other, but never listed by it.

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

from ..tags.tag_hash import hash_tag
from ..tags.tag_names import canonical_name

# Danbooru's adult category and groups (keyed by tag_hash.hash_tag of
# Danbooru's name), and the neutral names the shipped file uses instead
# (scripts/build_tag_groups.py renames them).
CATEGORY_RENAMES = {"98d44e13f455d916": "intimacy"}
GROUP_RENAMES = {
    "67f3196ce0a0dce0": "intimate_acts",
    "8b96ed61f429c0b1": "intimate_positions",
    "5f47ad44795518d9": "simulated_intimate_acts",
    "415881a3620ebd3d": "restraint_play",
    "5c5a7771ac8cd0b1": "intimate_attire",
    "b394be7d534989e5": "intimate_objects",
    "6672b930d5d08ec0": "bare_skin",
    "0f28c4960d96647e": "groin",
}
ADULT_GROUPS = frozenset(GROUP_RENAMES.values())


def _rename(name: str, renames: dict[str, str]) -> str:
    return renames.get(hash_tag(name), name)


TAG_GROUPS_PATH = Path(__file__).resolve().parents[2] / "data" / "tag_groups.json"
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
        "intimate_attire",
        "sleeves",
    }
)

# Groups whose tags describe the body itself: what stays when a character
# changes clothes, pose or scene (expressions, bare skin and posture don't).
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
# (`adjusting_scarf`, `towel_around_neck`, `hand_on_headwear`), not garments;
# what isn't on (`unworn_hat`, `no_gloves`); body parts filed under neckwear
# (`collarbone`, `nape`); carried things (`umbrella`, `shopping_bag`); names
# that only end like a garment (`mobile_suit`, and one more kept by hash).
_NOT_WORN = re.compile(
    r"^(adjusting|holding|kissing|no|unworn|removing|carrying|drawing)_|_around_neck$"
    r"|_grab$|^hands?_(on|in)_|(^|_)bag$"
    r"|^(long_neck|hand_fan|hand_tattoo|collarbone|nape|strangling|umbrella"
    r"|mobile_suit)$"
)
_NOT_WORN_HASHED = frozenset({"0d05a5ea6faa438b"})


def _not_worn(name: str) -> bool:
    return bool(_NOT_WORN.search(name)) or hash_tag(name) in _NOT_WORN_HASHED


# From the bare-skin group, the tags that say how a garment is cut or worn
# (`midriff`, `off_shoulder`, `shoulder_cutout`): part of an outfit, in the
# "exposure" group. A list, not a pattern: the group also holds actions
# (`adjusting_clothes`) and states of being unclothed, which never belong in
# an outfit.
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
# `striped_thighhighs`).
_COLOURED = re.compile(
    r"^(?:(?:light|dark|pale)_)?"
    r"(red|blue|green|yellow|orange|purple|pink|black|white|grey|gray|brown|"
    r"aqua|beige|silver|gold|multicolored|two-tone|see-through|striped|plaid|"
    r"polka_dot|checkered|camouflage|floral_print|leopard_print|frilled)_(.+)$"
)
# Garment hubs the groups leave out (`black_footwear`).
_GARMENT_HUBS = {
    "footwear": "attire",
    "headwear": "headwear",
    "legwear": "legwear",
    "neckwear": "neck_and_neckwear",
    "one-piece_swimsuit": "attire",
}
# A phrase about something else (`hand_in_pocket`, `girl_with_bag`): no
# garment ending for it.
_PHRASE = re.compile(r"_(with|in|on|under|over|from|and|of)_")


def tag_key(tag: str) -> str:
    return canonical_name(tag).lower()


# Garment words that also name other things (`onion_ring`, `seat_belt`,
# `wine_glasses`, `soul_gem`): as the ending of an unlisted tag they count only
# behind a colour or print (`red_belt`), where it's worn (`thumb_ring`,
# `waist_bow`) or a size or material (`huge_bow`, `leather_belt`).
_AMBIGUOUS = frozenset(
    {"badge", "bell", "belt", "bow", "gem", "glasses", "pocket", "ring", "sticker"}
)
_WORN_LEAD = re.compile(
    r"^(ankle|arm|back|belly|breast|chest|ear|ears|finger|foot|hair|hand|head|hip"
    r"|horn|knee|leg|lip|navel|neck|nose|shoulder|sleeve|tail|thigh|thumb"
    r"|toe|tongue|waist|wrist|large|huge|big|small|long|short|loose|open|tight"
    r"|thin|wide|single|double|multiple|leather|studded|spiked|rope|lace|fur"
    r"|metal|silk|satin|velvet|cloth|chain|oversized)$"
)
# Lead words kept by hash (tag_hash) rather than spelled in the pattern.
_WORN_LEAD_HASHED = frozenset({"d84f691fc4981d9d"})


def _worn_lead(word: str) -> bool:
    return bool(_WORN_LEAD.match(word)) or hash_tag(word) in _WORN_LEAD_HASHED


# What may stand in front of a cut or exposure ending (`bare_midriff`): any
# other word describes the body (`toned_midriff`, `huge_cleavage`).
_EXPOSURE_LEAD = frozenset({"bare", "exposed"})


def _clothing(entry: tuple[str, str, tuple[str, ...]]) -> bool:
    """Listed somewhere about clothing, attire or not (`adjusting_clothes`)."""
    return bool(groups_of(entry) & (ATTIRE_GROUPS | {"bare_skin"}))


def _garment_group(key: str) -> str | None:
    """The attire group of an unlisted tag that ends in a garment, whatever
    comes in front (`red_bikini`, `oversized_cropped_hoodie`,
    `white_lace_garter_belt`, `bare_midriff`; `star_hair_clip` as `hairclip`).
    The longest listed ending decides; one listed elsewhere is skipped
    (`floral_print_kimono` is a `kimono`, though `print_kimono` is a print),
    but one about clothing that isn't attire stops it (`girl_holding_mask`). `sky_blue_hair` has no garment ending."""
    if _PHRASE.search(key) or _not_worn(key):
        return None
    listed = entries()
    words = key.split("_")
    for i in range(1, len(words)):
        tail = "_".join(words[i:])
        if _not_worn(tail):
            return None
        front = words[:i]
        for name in dict.fromkeys((tail, tail.replace("_", ""))):
            entry = listed.get(name)
            if entry is None:
                if group := _GARMENT_HUBS.get(name) or UNLISTED_ATTIRE.get(name):
                    return group
                continue
            group = _attire_group(name, entry)
            if group is None:
                if _clothing(entry):
                    return None
                continue
            if group == EXPOSURE_GROUP:
                return group if set(front) <= _EXPOSURE_LEAD else None
            if name in _AMBIGUOUS:
                m = _COLOURED.match(key)
                worn = (m and m.group(2) == name) or _worn_lead(front[-1])
                return group if worn else None
            return group
    return None


def _unlisted_group(key: str) -> str | None:
    """An attire tag the groups don't list: a hub, or a garment with words in
    front. Only beside a loaded list, like everything else here."""
    if not entries():
        return None
    return UNLISTED_ATTIRE.get(key) or _garment_group(key)


Entry = tuple[str, str, tuple[str, ...]]


class Listed(dict):
    """``tag -> (category, group, also)``, plus the entries stored by hash:
    :meth:`get` and ``in`` find those by name too, iterating lists only the
    named ones (a hash is no tag to show)."""

    def __init__(self, named: dict[str, Entry], hashed: dict[str, Entry]):
        super().__init__(named)
        self.hashed = hashed

    def get(self, key, default=None):  # type: ignore[override]
        found = super().get(key)
        if found is None and isinstance(key, str):
            found = self.hashed.get(hash_tag(key))
        return default if found is None else found

    def __contains__(self, key) -> bool:
        return super().__contains__(key) or (
            isinstance(key, str) and hash_tag(key) in self.hashed
        )

    def is_hashed(self, key: str) -> bool:
        return not dict.__contains__(self, key) and key in self


def hide_entry(tag: str, info: dict) -> bool:
    """Whether a tag's entry is stored by hash: it has a sensitivity level, or
    sits in one of the adult groups."""
    from ..tags import tag_sensitivity

    return tag_sensitivity.level_of(tag) > 0 or info.get("group") in ADULT_GROUPS


def _renamed(info: dict) -> dict:
    out = dict(info)
    out["category"] = _rename(info["category"], CATEGORY_RENAMES)
    out["group"] = _rename(info["group"], GROUP_RENAMES)
    if "also" in info:
        out["also"] = [
            f"{_rename(c, CATEGORY_RENAMES)}/{_rename(g, GROUP_RENAMES)}"
            for c, _, g in (a.partition("/") for a in info["also"])
        ]
    return out


def shipped_form(tags: dict[str, dict]) -> tuple[dict[str, dict], dict[str, dict]]:
    """``(tags, hashed)`` as the shipped file stores Danbooru's groups: the
    adult ones renamed, the entries :func:`hide_entry` picks keyed by hash
    (scripts/build_tag_groups.py writes this)."""
    named: dict[str, dict] = {}
    hashed: dict[str, dict] = {}
    for tag, info in tags.items():
        info = _renamed(info)
        if hide_entry(tag, info):
            hashed[hash_tag(tag)] = info
        else:
            named[tag] = info
    return named, dict(sorted(hashed.items()))


def _entries(tags: object) -> dict[str, Entry]:
    out: dict[str, Entry] = {}
    if not isinstance(tags, dict):
        return out
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
        out[tag_key(name)] = (category, group, tuple(also))
    return out


def parse(doc: object) -> Listed:
    """The ``tag -> (category, group, also)`` map of a tag-group document, keys
    normalised (``hashed`` entries keep their hash). Malformed input yields an
    empty map (or skips the entry) rather than raising: a broken hand edit
    must not take the app down."""
    if not isinstance(doc, dict):
        return Listed({}, {})
    hashed = doc.get("hashed")
    return Listed(
        _entries(doc.get("tags")),
        {k: v for k, v in _entries(hashed).items()} if isinstance(hashed, dict) else {},
    )


@lru_cache(maxsize=1)
def entries() -> Listed:
    try:
        return parse(json.loads(TAG_GROUPS_PATH.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return Listed({}, {})


def groups_of(entry: tuple[str, str, tuple[str, ...]]) -> set[str]:
    return {entry[1], *(a.rpartition("/")[2] for a in entry[2])}


def _attire_group(tag: str, entry: tuple[str, str, tuple[str, ...]]) -> str | None:
    groups = groups_of(entry) & ATTIRE_GROUPS
    if not groups and "bare_skin" in groups_of(entry):
        return EXPOSURE_GROUP if tag in EXPOSURE_TAGS else None
    if not groups or _not_worn(tag):
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
    key = tag_key(tag)
    entry = entries().get(key)
    if entry is None:
        return _unlisted_group(key) is not None
    return _attire_group(key, entry) is not None


def is_identity(tag: str) -> bool:
    """A body-feature tag (hair, eyes, ears, ...). An unlisted tag counts when
    its name says so (``halo``, ``mole_under_eye``, ``x_pupils``); from the
    breasts group only the sizes do. Never attire."""
    key = tag_key(tag)
    # A passing eye state: how they look in one picture, not who they are.
    if key in EYE_STATES:
        return False
    entry = entries().get(key)
    if entry is None:
        return bool(_BODY_WORDS.search(key))
    if _attire_group(key, entry) is not None or key.startswith("looking_"):
        return False
    # An expression, though also listed with eyes (`@_@`, `closed_eyes`).
    if entry[1] == "face_tags":
        return False
    groups = groups_of(entry) & IDENTITY_GROUPS
    if groups == {"breasts_tags"}:
        return key.endswith("breasts") or key == "flat_chest"
    return bool(groups)


def group_of(tag: str) -> str | None:
    """The group of a listed tag, ``None`` when it is unlisted. An attire tag
    answers with its attire group (``bikini`` is attire, not ``water``);
    others with their most specific group."""
    key = tag_key(tag)
    entry = entries().get(key)
    if entry is None:
        return _unlisted_group(key)
    return _attire_group(key, entry) or entry[1]


def library_groups(names: Iterable[str]) -> dict[str, dict[str, str]]:
    """The group page's map: ``tags`` is ``tag -> group`` for each of
    ``names`` (the library's tags) that has one, ``categories`` is ``group ->
    top-level category`` for those groups, so a page can list a group's
    siblings."""
    listed = entries()
    tags: dict[str, str] = {}
    for name in names:
        key = tag_key(name)
        if key not in tags and (group := group_of(key)):
            tags[key] = group
    primary: dict[str, str] = {}
    for category, group, _also in [*listed.values(), *listed.hashed.values()]:
        primary.setdefault(group, category)
    worn = "attire_and_body_accessories"
    categories = {
        g: primary.get(g)
        or (worn if g in ATTIRE_GROUPS or g == EXPOSURE_GROUP else "more")
        for g in set(tags.values())
    }
    return {"tags": tags, "categories": categories}


def unlisted_attire(names: Iterable[str]) -> dict[str, str]:
    """``tag -> attire group`` for the unlisted garments among ``names`` (the
    tagger's vocabulary, the library's tags): coloured or otherwise
    described, which the lists below can't enumerate from the groups alone."""
    listed = entries()
    out: dict[str, str] = {}
    for name in names:
        key = tag_key(name)
        if key not in listed and (group := _unlisted_group(key)):
            out[key] = group
    return out


def attire_tags(extra: Iterable[str] = ()) -> dict[str, str]:
    """``tag -> attire group`` for every attire tag; ``extra`` names (the
    tagger's vocabulary) add the coloured garments among them."""
    out: dict[str, str] = {}
    listed = entries()
    for tag, entry in listed.items():
        group = _attire_group(tag, entry)
        if group:
            out[tag] = group
    if listed:
        out.update({t: g for t, g in UNLISTED_ATTIRE.items() if t not in listed})
        out.update(unlisted_attire(extra))
        # Entries stored by hash are found by name, among ``extra``.
        for name in extra:
            key = tag_key(name)
            if listed.is_hashed(key) and (group := _attire_group(key, listed.get(key))):
                out[key] = group
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


def facet_of_entry(
    key: str, entry: tuple[str, str, tuple[str, ...]] | None
) -> str | None:
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
    groups = groups_of(entry)
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
    key = tag_key(tag)
    return facet_of_entry(key, entries().get(key))


_facets_cache: tuple[dict, dict[str, str]] | None = None


def facets(extra: Iterable[str] = ()) -> dict[str, str]:
    """``tag -> facet`` for every listed tag that has one, plus the unlisted
    ``extra`` names that :func:`facet_of` places (a described garment, a body
    word). The listed part is rebuilt whenever the list itself is reloaded."""
    global _facets_cache
    listed = entries()
    if _facets_cache is None or _facets_cache[0] is not listed:
        out = {t: f for t, e in listed.items() if (f := facet_of_entry(t, e))}
        if listed:
            out.update({t: "outfit" for t in UNLISTED_ATTIRE if t not in listed})
        _facets_cache = (listed, out)
    added: dict[str, str] = {}
    if listed:
        for name in extra:
            key = tag_key(name)
            if key not in listed and (f := facet_of_entry(key, None)):
                added[key] = f
            elif listed.is_hashed(key) and (f := facet_of_entry(key, listed.get(key))):
                added[key] = f
    return {**_facets_cache[1], **added} if added else _facets_cache[1]
