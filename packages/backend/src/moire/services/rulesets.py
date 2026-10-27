"""User extraction rulesets: one per workflow signature, pinning dot-paths into
the raw doc for generation fields (see :mod:`services.gen_metadata`).

The one writer of ``gen_rulesets``. Rulesets are sig-global (not per-library),
so saving or deleting one reprojects every image of that signature. The
reprojection thread reads them on its own (``reproject._load_rulesets``).
"""

from __future__ import annotations

import time
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import schema as t
from ..database.db import async_conn, async_tx
from . import gen_metadata, reproject


def public_doc(sig: str, doc: dict) -> dict:
    """Reconstruct the public ruleset shape (id + stored fields/updated_at)."""
    return {"_id": sig, **(doc or {})}


async def list_all() -> list[dict]:
    async with async_conn() as conn:
        rows = (
            await conn.execute(sa.select(t.gen_rulesets.c.sig, t.gen_rulesets.c.doc))
        ).fetchall()
    return [public_doc(r.sig, r.doc) for r in rows]


async def doc_for(conn: AsyncConnection, sig: str | None) -> Any:
    """The stored ruleset doc of ``sig``, or None."""
    return (
        await conn.execute(
            sa.select(t.gen_rulesets.c.doc).where(t.gen_rulesets.c.sig == sig)
        )
    ).scalar()


async def get(sig: str) -> dict:
    async with async_conn() as conn:
        doc = await doc_for(conn, sig)
    if not doc:
        # A signature with no ruleset yet: return an empty editable shell.
        return {"_id": sig, "fields": {}}
    return public_doc(sig, doc)


async def put(sig: str, fields: Any) -> dict:
    fields = gen_metadata.clean_rule_fields(fields)
    doc = {"fields": fields, "updated_at": time.time()}
    async with async_tx() as conn:
        stmt = sqlite_insert(t.gen_rulesets).values(sig=sig, doc=doc)
        stmt = stmt.on_conflict_do_update(
            index_elements=[t.gen_rulesets.c.sig], set_={"doc": stmt.excluded.doc}
        )
        await conn.execute(stmt)
    # Re-derive gen.* for every image of this signature (sig-global).
    reproject.reproject_by_sig_async(sig)
    return public_doc(sig, doc)


async def delete(sig: str) -> None:
    async with async_tx() as conn:
        await conn.execute(sa.delete(t.gen_rulesets).where(t.gen_rulesets.c.sig == sig))
    reproject.reproject_by_sig_async(sig)
