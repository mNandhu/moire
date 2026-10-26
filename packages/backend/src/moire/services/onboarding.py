"""First-run setup: whether the app should open on the welcome page.

Stored in the ``app_settings`` row "onboarding" as ``{"status": ...}``. With
no row, a database that already has libraries counts as set up, so upgrading
never shows the welcome page to someone already using Moiré.
"""

from __future__ import annotations

import sqlalchemy as sa

from ..database import schema as t
from ..database.db import async_conn
from . import app_settings

_ROW = "onboarding"

#: pending: show the welcome page. done / skipped: open the gallery.
STATUSES = ("pending", "done", "skipped")


async def get_status() -> str:
    async with async_conn() as conn:
        doc = (await conn.execute(app_settings.doc_stmt(_ROW))).scalar()
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
    await app_settings.write(_ROW, doc)
