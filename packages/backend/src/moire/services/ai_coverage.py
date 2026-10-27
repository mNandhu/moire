"""AI-tag coverage: what "untagged" means, defined once.

``/ai/coverage`` counts it and ``AIJobManager.enqueue_untagged`` queues it, so
a run tags exactly the set the UI counted. Quarantined images are left out of
both, matching the default gallery (``image_visibility.not_quarantined``).
"""

from __future__ import annotations

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from .image_visibility import not_quarantined


def untagged_clause(library_id: str | None = None):
    """WHERE clause for the images AI tagging should pick up: visible and
    without AI tags, optionally within one library."""
    clause = sa.and_(t.images.c.has_ai_tags.is_(False), not_quarantined())
    if library_id:
        clause = sa.and_(clause, t.images.c.library_id == library_id)
    return clause


async def coverage() -> dict:
    """AI-tag coverage: how many images carry AI tags, globally and per library.

    ``has_ai_tags`` is the summary flag maintained by ``image_tags``, so a
    single grouped count is exact.
    """
    stmt = (
        sa.select(
            t.images.c.library_id,
            sa.func.count().label("total"),
            sa.func.coalesce(
                sa.func.sum(sa.cast(t.images.c.has_ai_tags, sa.Integer)), 0
            ).label("ai_tagged"),
            # No tags of any kind (`has_tags` false). The gallery's no_tags
            # filter, counted so the Tags page shortcut can show its size.
            sa.func.coalesce(
                sa.func.sum(
                    sa.case(
                        (sa.func.coalesce(t.images.c.has_tags, False).is_(False), 1),
                        else_=0,
                    )
                ),
                0,
            ).label("no_tags"),
        )
        .where(not_quarantined())
        .group_by(t.images.c.library_id)
        .order_by(sa.text("total DESC"))
    )
    async with async_conn() as conn:
        rows = (await conn.execute(stmt)).fetchall()
    per_library = [
        {
            "library_id": r.library_id,
            "total": r.total,
            "ai_tagged": int(r.ai_tagged),
        }
        for r in rows
    ]
    total = sum(r["total"] for r in per_library)
    ai_tagged = sum(r["ai_tagged"] for r in per_library)
    return {
        "total": total,
        "ai_tagged": ai_tagged,
        "untagged": total - ai_tagged,
        "no_tags": sum(int(r.no_tags) for r in rows),
        "per_library": per_library,
    }
