"""Tag rename / merge (Tags page). One intent, three kinds, three answers:

- **AI tags** come from the tagger's fixed, deterministic vocabulary. They are
  the reference names, so they are never renamed (a re-run would bring the old
  name straight back anyway).
- **Manual tags** are only ever written by the user, so a rename is a one-time
  rewrite of the stored tag (:func:`image_tags.rename_manual`).
- **Prompt tags** are rebuilt from the embedded prompt on every reprojection,
  so a one-time rewrite would be undone. A merge is stored as a rule in
  ``tag_aliases`` (``from -> to``) that reprojection applies to the extracted
  terms, and the affected images are reprojected now.

A rename keeps the tag's kind: ``manual:a`` becomes ``manual:b``, never an AI
tag. "Merge" is just a rename onto a name that already exists.

Rules are kept resolved, one hop each: renaming ``b -> c`` repoints an existing
``a -> b`` to ``a -> c``, and a rule that would loop is refused.
"""

from __future__ import annotations

import time

import anyio
import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import image_tags, reproject, tag_index
from .tag_names import canonical_name


class RenameError(ValueError):
    """An invalid rename (HTTP 422)."""


def _target_name(to: str, *, prompt: bool) -> str:
    """The canonical bare target name. A kind prefix typed by the user is
    dropped (the source's kind wins); prompt terms are stored lowercase."""
    name = image_tags.base_of(to.strip())
    name = canonical_name(name.lower() if prompt else name)
    if not name:
        raise RenameError("new name must not be empty")
    return name


async def _move_thumbnail(conn, old: str, new: str) -> None:
    """Carry a pinned mosaic thumbnail over to the target if it has none.
    Pins are keyed by name (``tag_index.pin_key``), not by source."""
    old, new = tag_index.pin_key(old), tag_index.pin_key(new)
    if old == new:
        return
    pinned = (
        await conn.execute(
            sa.select(t.tag_meta.c.thumb_image_id).where(t.tag_meta.c.tag == old)
        )
    ).scalar()
    # Its framing goes with it (keyed to the image, so it only applies there),
    # pinned cover or not.
    if (
        await conn.execute(sa.select(t.tag_focus.c.tag).where(t.tag_focus.c.tag == new))
    ).scalar() is None:
        await conn.execute(
            sa.update(t.tag_focus).where(t.tag_focus.c.tag == old).values(tag=new)
        )
    else:
        await conn.execute(sa.delete(t.tag_focus).where(t.tag_focus.c.tag == old))
    if pinned is None:
        return
    target_has = (
        await conn.execute(sa.select(t.tag_meta.c.tag).where(t.tag_meta.c.tag == new))
    ).scalar()
    if target_has is None:
        await conn.execute(
            sa.insert(t.tag_meta).values(
                tag=new, thumb_image_id=pinned, updated_at=time.time()
            )
        )
    await conn.execute(sa.delete(t.tag_meta).where(t.tag_meta.c.tag == old))


async def _move_character(conn, old: str, new: str) -> None:
    """Carry a character's settings (name, colour, avatar centre, whether it
    is one) over to the target if it has none, keyed like pins."""
    old, new = tag_index.pin_key(old), tag_index.pin_key(new)
    if old == new:
        return
    c = t.characters
    target_has = (await conn.execute(sa.select(c.c.tag).where(c.c.tag == new))).scalar()
    if target_has is None:
        await conn.execute(sa.update(c).where(c.c.tag == old).values(tag=new))
    else:
        await conn.execute(sa.delete(c).where(c.c.tag == old))


async def _images_with(tag: str) -> list[str]:
    async with async_conn() as conn:
        return list(
            (
                await conn.execute(
                    sa.select(t.image_tags.c.image_id).where(t.image_tags.c.tag == tag)
                )
            ).scalars()
        )


async def rename_tag(tag: str, to: str) -> dict:
    """Rename or merge stored tag ``tag`` (prefix included) into ``to`` (a bare
    name). Returns ``{kind, from, to, images}``."""
    tag = image_tags.canonical_tag(tag)
    if image_tags.is_manual(tag):
        new = image_tags.MANUAL_PREFIX + _target_name(to, prompt=False)
        if new == tag:
            raise RenameError("new name is the same as the old one")
        changed = await image_tags.rename_manual(tag, new)
        async with async_tx() as conn:
            await _move_thumbnail(conn, tag, new)
            await _move_character(conn, tag, new)
        tag_index.invalidate()
        return {"kind": "manual", "from": tag, "to": new, "images": changed}

    if not image_tags.is_prompt(tag):
        raise RenameError(
            "AI tags come from the tagger's fixed vocabulary and can't be renamed"
        )

    old_name = image_tags.base_of(tag)
    new_name = _target_name(to, prompt=True)
    async with async_tx() as conn:
        rules = {
            r.from_name: r.to_name
            for r in (
                await conn.execute(
                    sa.select(t.tag_aliases.c.from_name, t.tag_aliases.c.to_name)
                )
            ).fetchall()
        }
        if new_name == old_name:
            raise RenameError("new name is the same as the old one")
        if rules.get(new_name) == old_name:
            raise RenameError(
                f"{new_name} is already merged into {old_name}; remove that rule first"
            )
        # Keep rules one hop: a target that is itself merged away resolves to
        # where it went.
        new_name = rules.get(new_name, new_name)
        # Rules already pointing at the old name follow it to the new one.
        await conn.execute(
            sa.update(t.tag_aliases)
            .where(t.tag_aliases.c.to_name == old_name)
            .values(to_name=new_name)
        )
        stmt = sqlite_insert(t.tag_aliases).values(
            from_name=old_name, to_name=new_name, created_at=time.time()
        )
        await conn.execute(
            stmt.on_conflict_do_update(
                index_elements=[t.tag_aliases.c.from_name],
                set_={"to_name": new_name, "created_at": stmt.excluded.created_at},
            )
        )
        await _move_thumbnail(conn, tag, image_tags.to_prompt(new_name))
        await _move_character(conn, tag, image_tags.to_prompt(new_name))

    affected = await _images_with(tag)
    await anyio.to_thread.run_sync(reproject.reproject_ids, affected)
    tag_index.invalidate()
    return {
        "kind": "prompt",
        "from": tag,
        "to": image_tags.to_prompt(new_name),
        "images": len(affected),
    }


async def list_aliases() -> list[dict]:
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(t.tag_aliases).order_by(t.tag_aliases.c.created_at.desc())
            )
        ).fetchall()
    return [
        {"from": r.from_name, "to": r.to_name, "created_at": r.created_at} for r in rows
    ]


async def delete_alias(from_name: str) -> dict | None:
    """Drop a merge rule and reproject the images it had merged, so the
    original name comes back. ``None`` if there was no such rule."""
    from_name = canonical_name(from_name)
    async with async_tx() as conn:
        to_name = (
            await conn.execute(
                sa.select(t.tag_aliases.c.to_name).where(
                    t.tag_aliases.c.from_name == from_name
                )
            )
        ).scalar()
        if to_name is None:
            return None
        await conn.execute(
            sa.delete(t.tag_aliases).where(t.tag_aliases.c.from_name == from_name)
        )
    # Every image the rule touched now carries the target tag; re-deriving
    # those gives each its own prompt's name back.
    affected = await _images_with(image_tags.to_prompt(to_name))
    await anyio.to_thread.run_sync(reproject.reproject_ids, affected)
    tag_index.invalidate()
    return {"from": from_name, "to": to_name, "images": len(affected)}
