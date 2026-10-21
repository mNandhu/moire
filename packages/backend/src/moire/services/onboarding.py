"""First-run setup: whether the app should open on the welcome page.

Stored in the ``app_settings`` row "onboarding" as ``{"status": ...}``. With
no row, a database that already has libraries counts as set up, so upgrading
never shows the welcome page to someone already using Moiré.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database import schema as t
from ..database.db import async_conn, async_tx

_ROW = "onboarding"

#: pending: show the welcome page. done / skipped: open the gallery.
STATUSES = ("pending", "done", "skipped")


async def get_status() -> str:
    async with async_conn() as conn:
        doc = (
            await conn.execute(
                sa.select(t.app_settings.c.doc).where(t.app_settings.c._id == _ROW)
            )
        ).scalar()
        if isinstance(doc, dict) and doc.get("status") in STATUSES:
            return doc["status"]
        has_libraries = (
            await conn.execute(sa.select(t.libraries.c._id).limit(1))
        ).first() is not None
    return "done" if has_libraries else "pending"


async def set_status(status: str) -> None:
    if status not in STATUSES:
        raise ValueError(f"Unknown onboarding status: {status!r}")
    doc = {"status": status}
    async with async_tx() as conn:
        stmt = sqlite_insert(t.app_settings).values(_id=_ROW, doc=doc)
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.app_settings.c._id], set_={"doc": stmt.excluded.doc}
        )
        await conn.execute(stmt)
