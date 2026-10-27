"""What a character's tags say about their look, as pure statistics: the
colour of their hair and eyes, the tags that make them look like themselves
(their signature) and their gender. No IO: :mod:`services.characters` reads
the counts and hands them in.

The page's colour comes from the character's own hair and eye tags, never from
the pixels: clothing and scenery change from image to image, hair and eyes
don't. Each colour counts by the share of the character's images that carry
it; white, silver, grey and black only count when no real colour does.
"""

from __future__ import annotations

import math
import re

# Colour words in hair / eye tags, as (hue, saturation %, lightness %).
COLOURS: dict[str, tuple[int, int, int]] = {
    "red": (355, 70, 52),
    "dark_red": (355, 60, 38),
    "crimson": (350, 70, 45),
    "orange": (25, 80, 55),
    "yellow": (48, 85, 55),
    "blonde": (44, 75, 60),
    "light_brown": (28, 45, 50),
    "brown": (25, 45, 38),
    "green": (130, 50, 45),
    "light_green": (110, 50, 60),
    "dark_green": (140, 45, 30),
    "aqua": (178, 60, 50),
    "teal": (180, 55, 38),
    "light_blue": (200, 70, 65),
    "blue": (215, 70, 55),
    "dark_blue": (222, 60, 35),
    "purple": (275, 50, 55),
    "light_purple": (275, 55, 70),
    "dark_purple": (275, 45, 35),
    "violet": (270, 60, 60),
    "pink": (335, 70, 70),
    "light_pink": (340, 70, 80),
    "hot_pink": (330, 85, 60),
    "magenta": (310, 70, 50),
    "gold": (45, 80, 50),
    "amber": (38, 85, 50),
}
NEUTRALS = frozenset(
    {"white", "silver", "grey", "gray", "black", "light_grey", "dark_grey"}
)
# Brown is a real colour but a dull one: it gives way to any other.
_WEAK = {"brown": 0.5, "light_brown": 0.5}
# A colour leads only when this share of the character's images carry it.
MIN_SHARE = 0.25
_PART = re.compile(r"^(.+)_(hair|eyes)$")
# The colour reads solo images only once there are this many.
SOLO_ENOUGH = 3


def colour_of(base: str) -> str | None:
    """The colour word in a hair / eye tag (``large_innocent_green_eyes`` is
    green, ``light_blue_hair`` light blue), else ``None``. Neutral words come
    back too; the caller weighs them."""
    m = _PART.match(base.lower())
    if not m:
        return None
    words = m.group(1).split("_")
    for n in (2, 1):
        word = "_".join(words[-n:])
        if len(words) >= n and (word in COLOURS or word in NEUTRALS):
            return word
    return None


def palette(rows: list[tuple[str, str]], images: int) -> list[str]:
    """Up to three colours (``hsl(...)``) for a character, strongest first, from
    ``(image_id, base)`` rows of their hair / eye tags over ``images``
    images. Empty when no real colour is common enough. Pure."""
    if images <= 0:
        return []
    carried: dict[str, set[str]] = {}
    for image_id, base in rows:
        word = colour_of(base)
        if word in COLOURS:
            carried.setdefault(word, set()).add(image_id)
    weight = {
        word: len(ids) / images * _WEAK.get(word, 1.0) for word, ids in carried.items()
    }
    ranked = sorted(
        (w for w in weight if weight[w] >= MIN_SHARE * _WEAK.get(w, 1.0)),
        key=lambda w: -weight[w],
    )
    return [f"hsl({h} {s}% {li}%)" for h, s, li in (COLOURS[w] for w in ranked[:3])]


def solo_palette(
    rows: list[tuple[str, str]], images: int, crowded: set[str]
) -> list[str]:
    """:func:`palette`, but another character's hair and eyes shouldn't colour
    this one: the images they're alone in count, when there are enough of
    them (``crowded`` are the shared ones). Pure."""
    solo = images - len(crowded)
    if solo >= SOLO_ENOUGH:
        return palette([r for r in rows if r[0] not in crowded], solo)
    return palette(rows, images)


# How sure a share must be before a tag joins the signature: the Wilson lower
# bound (z = 1, roughly 68%) of its share must reach this, and the tag must be
# on two images. One image in three is a third, but on three images it could
# easily be chance; on fifty it isn't. See :func:`confident`.
CONFIDENT_SHARE = 0.17
# Hair and eye tags that allow a second colour in their slot.
MULTICOLOUR = {
    "hair": frozenset(
        {
            "multicolored_hair",
            "two-tone_hair",
            "gradient_hair",
            "split-color_hair",
            "streaked_hair",
            "colored_inner_hair",
            "rainbow_hair",
        }
    ),
    "eyes": frozenset({"heterochromia", "multicolored_eyes", "gradient_eyes"}),
}


def confident(n: int, images: int) -> bool:
    """Whether ``n`` of ``images`` is a share the signature can trust: on two
    images at least (one image alone is enough only for a one-image
    character), with a Wilson lower bound (z = 1) of ``n / images`` reaching
    :data:`CONFIDENT_SHARE`. With 2 or 3 images that takes 2 of them, with 4
    or 5 still 2 (half, then 40%); from 6 images on, the third
    :func:`signature` already asks for is enough. Pure."""
    if images <= 0 or n <= 0 or (n < 2 and images > 1):
        return False
    p = n / images
    denom = 1 + 1 / images
    centre = p + 1 / (2 * images)
    margin = math.sqrt(p * (1 - p) / images + 1 / (4 * images * images))
    return (centre - margin) / denom >= CONFIDENT_SHARE


def one_colour_per_slot(found: list[dict]) -> list[dict]:
    """``found`` (most common first) keeping one hair colour and one eye
    colour, the most common of each, or two where a multicolour tag of that
    slot (``multicolored_hair``, ``heterochromia``) is in ``found`` too: a
    character has one hair colour, and a stray ``brown_hair`` on one image is
    the tagger's noise. Other tags pass through. Pure."""
    tags = {r["tag"].lower() for r in found}
    room = {part: 2 if tags & multi else 1 for part, multi in MULTICOLOUR.items()}
    out = []
    for r in found:
        base = r["tag"].lower()
        m = _PART.match(base)
        if m and colour_of(base) is not None:
            part = m.group(2)
            if room[part] <= 0:
                continue
            room[part] -= 1
        out.append(r)
    return out


# Solo images the signature reads instead of all, when they're also at least
# half of all: see :func:`reads_solo`.
SOLO_PLENTY = 10


def reads_solo(images: int, solo: int) -> bool:
    """Whether a signature reads only the ``solo`` images (of ``images``).
    Not just :data:`SOLO_ENOUGH` as the palette asks: a colour wants purity,
    but a signature wants numbers, and a character on 100 images, 97 of them
    with someone else, shouldn't be judged on 3. So: enough solo images, and
    either half of all or :data:`SOLO_PLENTY` of them. Pure."""
    return solo >= SOLO_ENOUGH and (2 * solo >= images or solo >= SOLO_PLENTY)


def signature(
    counts: dict[str, int],
    images: int,
    library: dict[str, int],
    total: int,
    *,
    skip: set[str],
    visual: frozenset[str],
    limit: int = 30,
) -> list[dict]:
    """The tags that make a character look like themselves, from ``counts``
    of their tags over ``images`` images (see :func:`characters.signature_counts`).

    A tag qualifies when, in order:

    1. it is a ``visual`` tag, when there are any (the tagger's general tags:
       no artists, LoRA triggers or quality tags), and not in ``skip`` (other
       characters and their own names);
    2. it is on at least a third of the images, and at least twice as common
       there as across the library;
    3. that share is :func:`confident` for this many images, so with few
       images a one-off tag doesn't count;
    4. it survives :func:`one_colour_per_slot`.

    Most common first. Pure."""
    found = []
    for base, n in counts.items():
        if base in skip or images <= 0 or total <= 0:
            continue
        if visual and base.lower() not in visual:
            continue
        share = n / images
        overall = library.get(base, n) / total
        if share >= 1 / 3 and share >= 2 * overall and confident(n, images):
            found.append({"tag": base, "count": n})
    found.sort(key=lambda r: (-r["count"], r["tag"]))
    return one_colour_per_slot(found)[:limit]


# The facets (attire.FACETS) a character page's look keeps: the body and what
# they wear. Props, scenes, poses, expressions and anything the tag groups
# can't place are what one set of images shares, not the character.
LOOK = frozenset({"look", "outfit"})

GENDERS = {
    kind: (
        f"1{kind}",
        *(f"{n}{kind}s" for n in ("2", "3", "4", "5", "6+")),
        *((f"multiple_{kind}s",) if kind != "other" else ()),
    )
    for kind in ("girl", "boy", "other")
}


def gender(counts: dict[str, int], images: int) -> str | None:
    """``girl``, ``boy`` or ``other`` from the count tags on a character's
    images (:func:`characters.signature_counts`), else ``None``: the kind must be on at
    least half the images and twice as common as the next. A character who
    is always drawn beside someone of the other kind (``1girl`` and ``1boy``
    on every image) stays ``None``. Pure."""
    if images <= 0:
        return None
    score = {k: max(counts.get(t, 0) for t in tags) for k, tags in GENDERS.items()}
    ranked = sorted(score.items(), key=lambda kv: -kv[1])
    (top, n), (_, runner) = ranked[0], ranked[1]
    if n * 2 >= images and n >= 2 * runner:
        return top
    return None
