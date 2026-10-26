"""Which images count as visible: the SQL fragments every reader shares.

Quarantined images are hidden from the default feed and so from the Tags page
counts and pictures. No connections here, only expressions over the schema.
"""

from __future__ import annotations

import sqlalchemy as sa

from ..database import schema as t


def not_quarantined():
    """The images the default feed shows, and so the Tags page counts and
    pictures. A missing/NULL flag reads as not quarantined (legacy rows)."""
    return sa.func.coalesce(t.images.c.quarantined, False).is_(False)


def visible_tag_rows(it=None):
    """``EXISTS`` for an ``image_tags`` row (``it``, the table or an alias of
    it) whose image is visible: what the Tags page counts."""
    it = t.image_tags if it is None else it
    return sa.exists(
        sa.select(1).where(t.images.c._id == it.c.image_id, not_quarantined())
    )
