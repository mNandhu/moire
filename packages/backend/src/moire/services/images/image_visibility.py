"""Which images count as visible: the SQL fragments every reader shares.

Quarantined images are hidden from the default feed and so from the Tags page
counts and pictures. While the Global Sensitivity Filter is on
(:mod:`services.tags.sensitivity_filter`), so is every image whose level is
unknown or above its maximum. No connections here, only expressions over the
schema.

An image's level (:func:`image_level`) comes from:

- a rating picked by hand (``rating_manual``), which settles it;
- else the higher of the AI tagger's rating and ``tag_level``, the highest
  level among its tags. Prompt words can raise a level but can't vouch for
  an image: a ``tag_level`` of 0 counts only when the image has AI or manual
  tags (``has_tags``). A prompt alone that names nothing listed (a prompt of
  quality words) leaves the level unknown, as does having no tags at all.
"""

from __future__ import annotations

import sqlalchemy as sa

from ...database import schema as t
from ..tags import sensitivity_filter, tag_sensitivity

_NONE = -1


def not_quarantined():
    """Not in quarantine. A missing/NULL flag reads as not quarantined
    (legacy rows). Readers showing images use :func:`visible`, which adds the
    sensitivity filter; this alone is for counts that must see past it (what
    is left to AI-tag, so the filter's unknowns can be tagged)."""
    return sa.func.coalesce(t.images.c.quarantined, False).is_(False)


def _rating_level():
    im = t.images.c
    return sa.case(
        *((im.rating == name, i) for i, name in enumerate(tag_sensitivity.LEVELS)),
        else_=sa.null(),
    )


def image_level():
    """An image's level (0 general .. 3 explicit), NULL when unknown."""
    im = t.images.c
    rating = _rating_level()
    tags = sa.case(
        (im.tag_level > 0, im.tag_level),
        (sa.and_(im.tag_level == 0, sa.func.coalesce(im.has_tags, False)), 0),
        else_=sa.null(),
    )
    manual = sa.func.coalesce(im.rating_manual, False).is_(True)
    highest = sa.func.max(
        sa.func.coalesce(rating, _NONE), sa.func.coalesce(tags, _NONE)
    )
    return sa.case(
        (sa.and_(manual, rating.isnot(None)), rating),
        else_=sa.func.nullif(highest, _NONE),
    )


def within_filter():
    """The sensitivity filter alone: true while it is off."""
    top = sensitivity_filter.max_level()
    if top is None:
        return sa.true()
    level = image_level()
    return sa.and_(level.isnot(None), level <= top)


def visible():
    """The images the default feed shows, and so the Tags page counts and
    pictures, the characters, recipes and covers: not quarantined, and
    within the sensitivity filter."""
    return sa.and_(not_quarantined(), within_filter())


def visible_tag_rows(it=None):
    """``EXISTS`` for an ``image_tags`` row (``it``, the table or an alias of
    it) whose image is visible: what the Tags page counts."""
    it = t.image_tags if it is None else it
    return sa.exists(sa.select(1).where(t.images.c._id == it.c.image_id, visible()))


def in_view(quarantined: int | None):
    """The images a gallery view shows: only quarantined ones in the
    Quarantined view (``quarantined == 1``), else the default feed's. The feed
    and its filter facets share it, so a dropdown lists what its view holds.
    The sensitivity filter applies to both."""
    if quarantined == 1:
        return sa.and_(t.images.c.quarantined.is_(True), within_filter())
    return visible()
