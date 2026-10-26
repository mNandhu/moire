"""Which tag names are characters in this library: the one definition.

:mod:`services.tag_categories` reads the tagger's word list (listed names and
bare-name candidates); this module adds the library's say: a bare candidate
counts once most of its visible images also carry its series or full name
(:func:`tag_categories.confirmed`), and the user's ``characters.kind`` beats
both ways (``NULL`` is no say).
"""

from __future__ import annotations

import sqlalchemy as sa

from ..database import schema as t
from . import image_visibility, tag_categories


async def character_names(
    conn, vocab: tag_categories.Vocab, bases: set[str]
) -> frozenset[str]:
    """The character names (lowercased) for ``bases``: listed ones, plus the
    bare-name candidates the library backs (``tag_categories.confirmed``),
    counting visible images only, like everything else on the Tags page. The
    user's say on a character page (``characters.kind``) beats both."""
    names = set(await _listed_characters(conn, vocab, bases))
    overrides = (
        await conn.execute(
            sa.select(t.characters.c.tag, t.characters.c.kind).where(
                t.characters.c.kind.isnot(None)
            )
        )
    ).fetchall()
    for tag, kind in overrides:
        if kind == "character":
            names.add(tag.lower())
        else:
            # Not a character under any name: its bare name goes with it.
            gone = {tag.lower()} | {
                bare for bare, c in vocab.candidates.items() if c.full == tag.lower()
            }
            names -= gone
    return frozenset(names)


async def may_be_characters(conn, vocab: tag_categories.Vocab) -> set[str]:
    """Every name (lowercased) :func:`character_names` could call a character,
    whatever the library holds: the listed names, the bare-name candidates
    and the tags the user set a kind for (or made by hand). Narrows a query
    before it, so it must grow with :func:`character_names`. Python's lower(),
    like :func:`tag_categories.category`: SQLite's folds ASCII only."""
    tags = (await conn.execute(sa.select(t.characters.c.tag))).scalars()
    return set(vocab.names) | set(vocab.candidates) | {tag.lower() for tag in tags}


async def _listed_characters(
    conn, vocab: tag_categories.Vocab, bases: set[str]
) -> frozenset[str]:
    names = set(vocab.names)
    spellings: dict[str, set[str]] = {}
    for base in bases:
        if base.lower() in vocab.candidates:
            spellings.setdefault(base.lower(), set()).add(base)
    if not spellings:
        return frozenset(names)
    by_name = {key: vocab.candidates[key] for key in spellings}
    evidence = {c.series for c in by_name.values()} | {c.full for c in by_name.values()}
    it, other = t.image_tags, t.image_tags.alias("other")
    wanted = [b for group in spellings.values() for b in group]
    # One pass: every (candidate, image, evidence-or-NULL) row.
    rows = (
        await conn.execute(
            sa.select(it.c.base, it.c.image_id, other.c.base)
            .select_from(
                it.outerjoin(
                    other,
                    sa.and_(
                        other.c.image_id == it.c.image_id,
                        other.c.base.in_(evidence),
                    ),
                )
            )
            .where(it.c.base.in_(wanted), image_visibility.visible_tag_rows(it))
        )
    ).fetchall()
    images: dict[str, set[str]] = {}
    backed: dict[str, set[str]] = {}
    for base, image_id, found in rows:
        key = base.lower()
        images.setdefault(key, set()).add(image_id)
        cand = by_name[key]
        if found in (cand.series, cand.full):
            backed.setdefault(key, set()).add(image_id)
    for key, ids in images.items():
        if tag_categories.confirmed(len(ids), len(backed.get(key, ()))):
            names.add(key)
    return frozenset(names)
