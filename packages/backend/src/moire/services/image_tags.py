"""Image tag-state: the single owner of how tags live on an image row.

Conventions enforced here (and nowhere else):

- ``tags`` is one ordered JSON array holding three kinds of tag:
    * AI tags     : primary, stored unprefixed (e.g. ``"1girl"``)
    * Manual tags: stored with a ``manual:`` prefix (e.g. ``"manual:favourite"``)
    * Prompt tags: extracted from generation prompts, stored with a ``prompt:``
      prefix (e.g. ``"prompt:masterpiece"``). Owned by reprojection, not the user.
- ``has_tags``        : True iff ``tags`` has a *curatable* tag (a non-``prompt:``
  tag, i.e. AI or manual). Prompt-only images stay "untagged" for curation.
- ``has_ai_tags``     : True iff ``tags`` has a tag that is neither manual nor prompt.
- ``has_prompt_tags``: True iff ``tags`` contains at least one ``prompt:`` tag.
- ``rating``          : one of RATINGS; reset to ``"-"`` when AI tags are cleared.

Every write recomputes the three flags from the resulting array
(:func:`recompute_flags`) and rebuilds this image's rows in the derived
``image_tags`` join table, all inside one transaction, so the booleans and the
index table can never drift from the array they summarise. Callers hand the repo a
high-level intent (apply manual / remove / replace AI / clear AI / replace prompt);
they never assemble SQL.
"""

from __future__ import annotations

from typing import Any, Callable

import sqlalchemy as sa
from sqlalchemy import Connection
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import tag_index
from .tag_kinds import (
    base_of,
    canonical_tag,
    is_manual,
    is_prompt,
    recompute_flags,
    to_manual,
)

# Re-exported for callers not yet moved to :mod:`tag_kinds` /
# :mod:`image_visibility` (owned by other lanes this pass). New code imports
# those modules directly; this module adds nothing to the vocabulary.
from .tag_kinds import (  # noqa: F401
    ANY_PREFIX,
    MANUAL_PREFIX,
    PROMPT_PREFIX,
    any_variants,
    excluded_prefixes,
    expand_search_tag,
    is_any,
    tag_match_groups,
    to_prompt,
)
from .image_visibility import not_quarantined  # noqa: F401

# Canonical rating vocabulary used by the API, UI and AI tagger.
RATINGS = ("-", "general", "sensitive", "questionable", "explicit")


def initial_tag_fields() -> dict[str, Any]:
    """Tag-state column defaults for a freshly indexed image (insert payload)."""
    return {**tag_state_values([]), "quarantined": False, "score": 0}


def normalize_rating(raw: str | None) -> str | None:
    """Map a raw rating label to the canonical vocabulary.

    Returns ``"-"`` for empty/none, the canonical label for known values, and
    ``None`` for anything unrecognised. Callers decide whether ``None`` means
    "reject" (API) or "fall back to '-'" (AI tagger).
    """
    r = (raw or "").strip().lower()
    if r in ("", "-", "none"):
        return "-"
    if r in ("general", "safe"):
        return "general"
    if r in ("sensitive", "questionable", "explicit"):
        return r
    return None


# --- Image id variants (pure) -------------------------------------------------


def id_variants(image_id: str) -> list[str]:
    """Alternate ``_id`` spellings to tolerate Windows ``\\`` vs POSIX ``/``.

    The primary id is intentionally excluded; callers try it first.
    """
    variants: list[str] = []
    if "/" in image_id:
        variants.append(image_id.replace("/", "\\"))
    if "\\" in image_id:
        variants.append(image_id.replace("\\", "/"))
    return variants


def id_candidates(image_id: str) -> list[str]:
    """The ordered ``_id`` spellings to try for a lookup: the primary id first,
    then its slash/backslash variants. The single source of this ordering. Every
    id lookup iterates this, so the resolution order can never drift."""
    return [image_id, *id_variants(image_id)]


# --- Tag-set transforms (pure) ------------------------------------------------
#
# Replace the old Mongo aggregation-pipeline updates. Each takes the current tag
# list and returns the next one; the flag recompute + join-table rebuild happen in
# the repo layer below.


# The ``images`` columns a tag write sets: the array and the flags it
# implies. The one column list for every writer (single, bulk, insert
# defaults), so a column added here reaches all of them.
TAG_STATE_COLUMNS = ("tags", "has_tags", "has_ai_tags", "has_prompt_tags")


def tag_state_values(tags: list[str]) -> dict[str, Any]:
    """Values for :data:`TAG_STATE_COLUMNS` (exactly those, in that order)
    for a write of ``tags``."""
    values = {"tags": tags, **recompute_flags(tags)}
    return {c: values[c] for c in TAG_STATE_COLUMNS}


def union_tags(existing: list[str], add: list[str]) -> list[str]:
    """Append tags not already present, preserving existing order (dedup)."""
    out = list(existing)
    seen = set(existing)
    for tag in add:
        if tag not in seen:
            seen.add(tag)
            out.append(tag)
    return out


def without_tags(existing: list[str], remove: list[str]) -> list[str]:
    drop = set(remove)
    return [tag for tag in existing if tag not in drop]


def with_replaced_ai(existing: list[str], ai_tags: list[str]) -> list[str]:
    """Swap the unprefixed (AI) tags, keeping manual + prompt tags."""
    keep = [tag for tag in existing if is_manual(tag) or is_prompt(tag)]
    return keep + list(ai_tags)


def with_replaced_prompt(existing: list[str], prompt_tags: list[str]) -> list[str]:
    """Swap the ``prompt:`` tags, keeping AI + manual tags. ``prompt_tags`` are
    already prefixed by the caller."""
    keep = [tag for tag in existing if not is_prompt(tag)]
    return keep + list(prompt_tags)


def with_cleared_ai(existing: list[str]) -> list[str]:
    """Drop AI tags, keeping manual + prompt tags."""
    return [tag for tag in existing if is_manual(tag) or is_prompt(tag)]


def with_renamed(existing: list[str], old: str, new: str) -> list[str]:
    """Replace stored tag ``old`` with ``new`` in place; if ``new`` is already
    there (a merge), the first occurrence wins and the duplicate drops."""
    swapped = [new if tag == old else tag for tag in existing]
    return list(dict.fromkeys(swapped))


def _tag_rows(image_id: str, tags: list[str]) -> list[dict[str, str]]:
    """Derived ``image_tags`` rows for an image (deduped, with ``base``)."""
    seen: set[str] = set()
    rows: list[dict[str, str]] = []
    for tag in tags:
        if tag in seen:
            continue
        seen.add(tag)
        rows.append({"image_id": image_id, "tag": tag, "base": base_of(tag)})
    return rows


# --- Row → document reconstruction --------------------------------------------


def row_to_doc(row: Any) -> dict[str, Any]:
    """Reconstruct the public image document from a row mapping.

    Drops the promoted ``gen_*`` helper columns (redundant with the ``gen`` JSON)
    so the shape matches what the API returned under Mongo.
    """
    doc = dict(row._mapping)
    for helper in ("gen_model", "gen_workflow_sig", "gen_group_id", "gen_prompt"):
        doc.pop(helper, None)
    if doc.get("tags") is None:
        doc["tags"] = []
    return doc


# --- Repository (I/O) ---------------------------------------------------------


async def resolve_image_id(conn: AsyncConnection, image_id: str) -> str | None:
    """Return the stored ``_id`` matching ``image_id`` (slash/backslash tolerant).

    The one async resolver: any caller holding a connection that needs the
    canonical ``_id`` for a possibly-variant spelling delegates here.
    """
    for candidate in id_candidates(image_id):
        found = (
            await conn.execute(
                sa.select(t.images.c._id).where(t.images.c._id == candidate)
            )
        ).scalar()
        if found is not None:
            return found
    return None


async def find_image(image_id: str, projection: dict | None = None) -> dict | None:
    """Look up an image by id, tolerating slash/backslash id variants.

    ``projection`` is accepted for call-site compatibility but ignored; a single
    row fetch is cheap, and callers only read a handful of fields.
    """
    async with async_conn() as conn:
        for candidate in id_candidates(image_id):
            row = (
                await conn.execute(
                    sa.select(t.images).where(t.images.c._id == candidate)
                )
            ).first()
            if row is not None:
                return row_to_doc(row)
    return None


def _dirty_tag_index() -> None:
    """Mark the derived tag aggregation stale, after our transaction committed.
    Every async tag write funnels through the transaction owners below, so no
    caller has to remember this."""
    tag_index.invalidate()


def _persist_statements(
    image_id: str,
    new_tags: list[str],
    extra: dict[str, Any] | None = None,
) -> tuple[list[Any], list[dict[str, str]]]:
    """The tag-state write for one image, as statements: update the array +
    recomputed flags, drop this image's join rows, and the rows to reinsert.

    Built once and executed by both the async path (:func:`_persist`) and the
    caller-owned sync path (:func:`rewrite_tags_sync`), so the invariant
    binding ``tags`` to its flags and its join rows exists in exactly one place.
    """
    values = tag_state_values(new_tags)
    if extra:
        values.update(extra)
    statements = [
        sa.update(t.images).where(t.images.c._id == image_id).values(**values),
        sa.delete(t.image_tags).where(t.image_tags.c.image_id == image_id),
    ]
    return statements, _tag_rows(image_id, new_tags)


async def _persist(
    conn: AsyncConnection,
    image_id: str,
    new_tags: list[str],
    extra: dict[str, Any] | None = None,
) -> None:
    """Write the tag array + recomputed flags + rebuilt join rows for one image."""
    statements, rows = _persist_statements(image_id, new_tags, extra)
    for stmt in statements:
        await conn.execute(stmt)
    if rows:
        await conn.execute(sa.insert(t.image_tags), rows)


async def _mutate_tags(
    image_id: str,
    transform: Callable[[list[str]], list[str]],
    *,
    extra: dict[str, Any] | None = None,
) -> None:
    """Resolve, read the current tag array, apply ``transform``, and persist:
    the one read-modify-write path behind every high-level tag intent. No-op if
    the image is unknown."""
    async with async_tx() as conn:
        resolved = await resolve_image_id(conn, image_id)
        if resolved is None:
            return
        current = (
            await conn.execute(
                sa.select(t.images.c.tags).where(t.images.c._id == resolved)
            )
        ).scalar() or []
        await _persist(conn, resolved, transform(current), extra=extra)
    _dirty_tag_index()


async def apply_manual(image_id: str, tags: list[str]) -> None:
    await _mutate_tags(
        image_id,
        lambda current: union_tags(
            current, [canonical_tag(to_manual(x)) for x in tags]
        ),
    )


async def remove_tags(image_id: str, tags: list[str]) -> None:
    """Remove stored tags (any kind, prefix included). Either spelling of a
    name matches: the canonical form is what is stored."""
    drop = [canonical_tag(x) for x in tags]
    await _mutate_tags(image_id, lambda current: without_tags(current, drop))


def with_manual_edit(
    existing: list[str], *, add: list[str], remove: list[str]
) -> list[str]:
    """Add and remove *manual* tags (bare names, prefixed here). Removal runs
    first, so a name in both lists ends up present. AI and prompt tags are never
    touched: a bulk edit is curation, not a rewrite of what the tagger or the
    prompt produced."""
    dropped = without_tags(existing, [canonical_tag(to_manual(x)) for x in remove])
    return union_tags(dropped, [canonical_tag(to_manual(x)) for x in add])


async def bulk_manual(
    image_ids: list[str], *, add: list[str], remove: list[str]
) -> tuple[int, int]:
    """Apply one manual-tag edit to many images in a single transaction.

    One transaction rather than one per image: a selection of a thousand is one
    writer slot on single-writer SQLite instead of a thousand, and the edit
    lands all or nothing. Unknown ids are skipped. Returns ``(matched,
    modified)``.
    """
    matched = modified = 0
    async with async_tx() as conn:
        seen: set[str] = set()
        for image_id in image_ids:
            resolved = await resolve_image_id(conn, image_id)
            if resolved is None or resolved in seen:
                continue
            seen.add(resolved)
            matched += 1
            current = (
                await conn.execute(
                    sa.select(t.images.c.tags).where(t.images.c._id == resolved)
                )
            ).scalar() or []
            new = with_manual_edit(current, add=add, remove=remove)
            if new != current:
                modified += 1
                await _persist(conn, resolved, new)
    if modified:
        _dirty_tag_index()
    return matched, modified


async def rename_manual(old: str, new: str) -> int:
    """Rename (or, when ``new`` exists, merge) a manual tag on every image that
    carries it, in one transaction. Both are stored ``manual:`` tags. Returns
    the number of images changed."""
    async with async_tx() as conn:
        rows = (
            await conn.execute(
                sa.select(t.images.c._id, t.images.c.tags).where(
                    sa.exists(
                        sa.select(1).where(
                            t.image_tags.c.image_id == t.images.c._id,
                            t.image_tags.c.tag == old,
                        )
                    )
                )
            )
        ).fetchall()
        for row in rows:
            await _persist(conn, row._id, with_renamed(row.tags or [], old, new))
    if rows:
        _dirty_tag_index()
    return len(rows)


async def replace_ai(
    image_id: str, *, ai_tags: list[str], ai_meta: dict[str, Any], rating: str
) -> None:
    await _mutate_tags(
        image_id,
        lambda current: with_replaced_ai(current, ai_tags),
        extra={"ai": ai_meta, "rating": rating},
    )


async def clear_ai(image_id: str) -> None:
    """Drop one image's AI tags, tagger metadata and rating (before a re-tag).
    Manual and prompt tags stay."""
    await _mutate_tags(image_id, with_cleared_ai, extra={"ai": None, "rating": "-"})


# --- Scalar column writes (rating / score / quarantine) -----------------------
#
# These are the only writers of the per-image scalar columns, so the documented
# single-owner rule (rating in particular) holds: no router assembles SQL. Each
# returns the resolved ``_id`` (so the caller can 404) or ``None`` if unknown.


async def _set_columns(image_id: str, **values: Any) -> str | None:
    async with async_tx() as conn:
        resolved = await resolve_image_id(conn, image_id)
        if resolved is None:
            return None
        await conn.execute(
            sa.update(t.images).where(t.images.c._id == resolved).values(**values)
        )
        return resolved


async def set_rating(image_id: str, rating: str) -> str | None:
    """Set the content-safety rating (caller normalizes via ``normalize_rating``)."""
    return await _set_columns(image_id, rating=rating)


async def set_score(image_id: str, score: int) -> str | None:
    """Set the 0-5 quality score (caller validates the range)."""
    return await _set_columns(image_id, score=score)


async def set_quarantine(image_id: str, quarantined: bool) -> str | None:
    """Toggle the DB-only quarantine flag (hides from the default feed and
    from the Tags page, whose counts and covers then change)."""
    resolved = await _set_columns(image_id, quarantined=quarantined)
    if resolved is not None:
        _dirty_tag_index()
    return resolved


async def clear_ai_all() -> tuple[int, int]:
    """Clear AI tags across every image. Returns ``(matched, modified)``."""
    async with async_tx() as conn:
        rows = (
            await conn.execute(sa.select(t.images.c._id, t.images.c.tags))
        ).fetchall()
        matched = len(rows)
        modified = 0
        for row in rows:
            current = row.tags or []
            new = with_cleared_ai(current)
            if new != current:
                modified += 1
            await _persist(conn, row._id, new, extra={"ai": None, "rating": "-"})
    _dirty_tag_index()
    return matched, modified


# --- Sync repo helpers (scanner / reproject threads) --------------------------


def rewrite_tags_sync(
    conn: Connection,
    image_id: str,
    new_tags: list[str],
    extra: dict[str, Any] | None = None,
) -> None:
    """Persist a whole new tag array on a caller-owned sync transaction. For
    one-off data migrations (services/tag_migrations.py) and folding a nested
    library's copies (services/library_nesting.py); like
    :func:`replace_prompt_many_sync`, the caller invalidates the tag index."""
    statements, rows = _persist_statements(image_id, new_tags, extra)
    for stmt in statements:
        conn.execute(stmt)
    if rows:
        conn.execute(sa.insert(t.image_tags), rows)


def replace_prompt_many_sync(
    conn: Connection,
    items: list[tuple[str, list[str], list[str]]],
    *,
    force: bool = False,
) -> int:
    """Replace ``prompt:`` tags on many images at once, on a caller-owned sync
    transaction so reprojection writes a whole batch per commit. Each item is
    ``(image_id, its current tags, its new prompt tags)``; images whose tag
    array comes out the same are not written unless ``force``. Returns how
    many were written.

    The bulk twin of :func:`_persist_statements` (same columns,
    :data:`TAG_STATE_COLUMNS` with :func:`tag_state_values`, and the same
    join rows), as one executemany per
    statement instead of three per image.
    Deliberately does *not* invalidate the tag index: the caller owns the
    transaction, so only the caller knows when the write became visible
    (:func:`services.reproject._flush_batch` does, once per batch).
    """
    changed: list[tuple[str, list[str]]] = []
    for image_id, current, prompt_tags in items:
        new = with_replaced_prompt(current, prompt_tags)
        if force or new != current:
            changed.append((image_id, new))
    if not changed:
        return 0
    # Bind names carry a ``b_`` prefix: one equal to a column name collides
    # with that column in ``update().values()``.
    params = [
        {"b_id": image_id, **{f"b_{k}": v for k, v in tag_state_values(new).items()}}
        for image_id, new in changed
    ]
    conn.execute(
        sa.update(t.images)
        .where(t.images.c._id == sa.bindparam("b_id"))
        .values(
            **{
                k: sa.bindparam(f"b_{k}", type_=t.images.c[k].type)
                for k in TAG_STATE_COLUMNS
            }
        ),
        params,
    )
    conn.execute(
        sa.delete(t.image_tags).where(
            t.image_tags.c.image_id.in_([image_id for image_id, _ in changed])
        )
    )
    rows = [row for image_id, new in changed for row in _tag_rows(image_id, new)]
    if rows:
        conn.execute(sa.insert(t.image_tags), rows)
    return len(changed)
