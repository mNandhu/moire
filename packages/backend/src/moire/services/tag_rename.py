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

A **split** rule reads one prompt name as several (``long_white_hair`` ->
``long_hair``, ``white_hair``), kept in ``tag_splits``; Danbooru-backed
suggestions for both come from :mod:`tag_canon`.

Rules are kept resolved, one hop each: renaming ``b -> c`` repoints an existing
``a -> b`` to ``a -> c`` (and a split's ``b`` the same way), a target with a
split of its own stands for its split, and a rule that would loop is refused.
"""

from __future__ import annotations

import time

import anyio
import sqlalchemy as sa

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import danbooru_tags, image_tags, reproject, tag_canon, tag_index
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


async def _images_with(tags: list[str], *, every: bool = False) -> list[str]:
    """Images carrying any of ``tags`` (with ``every``, all of them)."""
    if not tags:
        return []
    it = t.image_tags
    stmt = sa.select(it.c.image_id).where(it.c.tag.in_(tags)).group_by(it.c.image_id)
    if every:
        stmt = stmt.having(sa.func.count(sa.distinct(it.c.tag)) == len(set(tags)))
    async with async_conn() as conn:
        return list((await conn.execute(stmt)).scalars())


async def _load_rules(conn) -> dict[str, tuple[list[str], float | None]]:
    """Every prompt rule as ``from -> ([to, ...], created_at)``: a merge has
    one target, a split several."""
    rules = {
        r.from_name: ([r.to_name], r.created_at)
        for r in await conn.execute(sa.select(t.tag_aliases))
    }
    for r in await conn.execute(sa.select(t.tag_splits)):
        rules[r.from_name] = (list(r.to_names), r.created_at)
    return rules


async def _put_rule(
    conn, name: str, targets: list[str], created_at: float | None
) -> None:
    """Store ``name -> targets`` in the table its shape belongs to, dropping
    any rule for ``name`` in the other (and in both when ``targets`` is
    empty)."""
    await conn.execute(
        sa.delete(t.tag_aliases).where(t.tag_aliases.c.from_name == name)
    )
    await conn.execute(sa.delete(t.tag_splits).where(t.tag_splits.c.from_name == name))
    if len(targets) == 1:
        await conn.execute(
            sa.insert(t.tag_aliases).values(
                from_name=name, to_name=targets[0], created_at=created_at
            )
        )
    elif targets:
        await conn.execute(
            sa.insert(t.tag_splits).values(
                from_name=name, to_names=targets, created_at=created_at
            )
        )


def _character_rows():
    """Character pages, not names the user said aren't one."""
    c = t.characters
    return sa.select(c.c.tag).where(sa.or_(c.c.kind.is_(None), c.c.kind != "general"))


async def _is_character(conn, name: str) -> bool:
    key = tag_index.pin_key(image_tags.to_prompt(name))
    stmt = _character_rows().where(t.characters.c.tag == key)
    return (await conn.execute(stmt)).scalar() is not None


async def _write_rule(
    conn, name: str, targets: list[str], rules: dict | None = None
) -> list[str]:
    """Store the rule ``name -> targets`` and return its targets as stored.
    ``rules`` (from :func:`_load_rules`) is kept up to date in place, so a
    batch reads them once.

    Rules stay one hop: a target that has a rule of its own stands for that
    rule's targets, and rules that pointed at ``name`` now point where it
    goes. A rule that would lead back to ``name`` is refused, and so is
    splitting a character (its page would have no one tag to follow)."""
    if name in targets:
        raise RenameError("new name is the same as the old one")
    if rules is None:
        rules = await _load_rules(conn)
    resolved = list(
        dict.fromkeys(x for to in targets for x in rules.get(to, ([to], None))[0])
    )
    if name in resolved:
        through = next(to for to in targets if name in rules.get(to, ([to], None))[0])
        raise RenameError(
            f"{through} is already merged into {name}; remove that rule first"
        )
    if len(resolved) > 1 and await _is_character(conn, name):
        raise RenameError(f"{name} is a character, so it can't be split")
    for src, (to, created_at) in list(rules.items()):
        if name in to and src != name:
            repointed = [x for y in to for x in (resolved if y == name else [y])]
            repointed = [x for x in dict.fromkeys(repointed) if x != src]
            await _put_rule(conn, src, repointed, created_at)
            if repointed:
                rules[src] = (repointed, created_at)
            else:
                del rules[src]
    now = time.time()
    await _put_rule(conn, name, resolved, now)
    rules[name] = (resolved, now)
    if len(resolved) == 1:
        await _move_thumbnail(
            conn, image_tags.to_prompt(name), image_tags.to_prompt(resolved[0])
        )
        await _move_character(
            conn, image_tags.to_prompt(name), image_tags.to_prompt(resolved[0])
        )
    return resolved


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
        resolved = await _write_rule(conn, old_name, [new_name])

    affected = await _images_with([tag])
    await anyio.to_thread.run_sync(reproject.reproject_ids, affected)
    tag_index.invalidate()
    return {
        "kind": "prompt",
        "from": tag,
        # Merging onto a name that is split stands for its split.
        "to": image_tags.to_prompt(resolved[0]),
        "to_all": [image_tags.to_prompt(x) for x in resolved],
        "images": len(affected),
    }


async def add_rules(rules: list[tuple[str, list[str]]]) -> dict:
    """Store several prompt rules at once (accepted suggestions): one
    transaction, then one reprojection of every image they touch. A rule
    that can't be kept (a loop, an empty name) is skipped with its reason,
    not fatal."""
    added: list[str] = []
    skipped: list[dict] = []
    async with async_tx() as conn:
        stored = await _load_rules(conn)
        for name, targets in rules:
            try:
                name = _target_name(name, prompt=True)
                await _write_rule(
                    conn,
                    name,
                    list(dict.fromkeys(_target_name(x, prompt=True) for x in targets)),
                    stored,
                )
            except RenameError as exc:
                skipped.append({"from": name, "reason": str(exc)})
                continue
            added.append(name)
    affected = await _images_with([image_tags.to_prompt(n) for n in added])
    await anyio.to_thread.run_sync(reproject.reproject_ids, affected)
    tag_index.invalidate()
    return {"rules": len(added), "skipped": skipped, "images": len(affected)}


async def merge_suggestions() -> dict:
    """Prompt tags in the library that Danbooru names otherwise, read by
    :mod:`tag_canon`, most used first. Tags with a rule already, and
    characters, are left out. Empty until Danbooru's list has been
    downloaded (by the prompt board): browsing tags never fetches it.
    Kept until the next tag write or a new list, like the tag index."""
    tags = await danbooru_tags.load_present()
    cached = tag_index.read_derived("merge-suggestions")
    if cached is not None and cached[0] is tags:
        return cached[1]
    gen = tag_index.current_generation()
    it = t.image_tags
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(it.c.base, sa.func.count().label("n"))
                .where(it.c.tag.like(f"{image_tags.PROMPT_PREFIX}%"))
                .group_by(it.c.base)
            )
        ).fetchall()
        ruled = set(await _load_rules(conn))
        ruled.update((await conn.execute(_character_rows())).scalars())
    counts = {r.base: r.n for r in rows if r.base not in ruled}
    found = await anyio.to_thread.run_sync(tag_canon.suggest_all, list(counts), tags)
    out = {
        "available": bool(tags.tags),
        "suggestions": sorted(
            (
                {
                    "from": s.name,
                    "to": list(s.to),
                    "kind": s.kind,
                    "images": counts[s.name],
                }
                for s in found
            ),
            key=lambda s: (-s["images"], s["from"]),
        ),
    }
    tag_index.store_derived("merge-suggestions", gen, (tags, out))
    return out


async def list_aliases() -> list[dict]:
    """Merge and split rules, newest first. ``to`` is a list (one name for a
    merge)."""
    async with async_conn() as conn:
        rules = await _load_rules(conn)
    return [
        {"from": name, "to": to, "created_at": created_at}
        for name, (to, created_at) in sorted(
            rules.items(), key=lambda kv: -(kv[1][1] or 0)
        )
    ]


async def delete_alias(from_name: str) -> dict | None:
    """Drop a merge or split rule and reproject the images it touched, so the
    original name comes back. ``None`` if there was no such rule."""
    from_name = canonical_name(from_name)
    async with async_tx() as conn:
        rule = (await _load_rules(conn)).get(from_name)
        if rule is None:
            return None
        await _put_rule(conn, from_name, [], None)
    # Every image the rule touched carries all its targets; re-deriving those
    # gives each its own prompt's names back.
    targets = rule[0]
    affected = await _images_with(
        [image_tags.to_prompt(x) for x in targets], every=True
    )
    await anyio.to_thread.run_sync(reproject.reproject_ids, affected)
    tag_index.invalidate()
    return {"from": from_name, "to": targets, "images": len(affected)}
