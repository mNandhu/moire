"""Character recipes: what the Generate composer's Character block writes.

A recipe is computed from the library, with the user's edits on top (the
``recipe_edits`` row; an edit wins, like the ``characters`` overrides):

- the character tag (the page key, the tagger's full name);
- identity tags: the character's signature (:func:`characters.signature`)
  limited to body features (hair, eyes, ears, ...); attire belongs to the
  outfit, and scene, pose and expression tags to neither;
- the default outfit: the signature's attire tags (phase 4 shows it);
- a LoRA: one mostly used with this character, picked by the images where the
  character was prompted and the tagger confirmed it (else just prompted),
  scored images counting more, at its usual strength.

The pick is by stem (``image_loras.name``); the installed file it resolves to
comes from :mod:`services.comfy_models`, so ComfyUI gets a name it has.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from ..database.db import async_conn, async_tx
from ..database import schema as t
from . import (
    attire,
    characters,
    comfy_models,
    image_visibility,
    tag_categories,
    tag_detail,
    tag_index,
    tag_kinds,
)
from .generator_graph import lora_stem
from .tag_kinds import canonical_tag

# A LoRA counts as this character's when at least this share of the images it
# was used on are theirs: a style or detail LoRA used on everything never is.
OWN_SHARE = 0.5
# ... and on at least this many of their images (one image proves nothing).
MIN_IMAGES = 3
DEFAULT_STRENGTH = 1.0
IDENTITY_LIMIT = 12
OUTFIT_LIMIT = 12


@dataclass(frozen=True)
class LoraUse:
    """One LoRA over a character's images. ``confirmed`` / ``prompted`` are
    score-weighted image counts (an image counts 1 + its score)."""

    stem: str
    images: int  # this character's images that used it
    total: int  # every visible image that used it
    confirmed: float
    prompted: float
    strength: float | None


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def name_words(names: list[str]) -> list[str]:
    """The character's names as they'd appear in a LoRA file name, series
    dropped (``hu_tao_(genshin_impact)`` -> ``hutao``). Pure."""
    out = []
    for n in names:
        w = _squash(re.sub(r"_?\(.*\)$", "", n))
        if len(w) >= 3 and w not in out:
            out.append(w)
    return out


def lora_candidates(
    uses: list[LoraUse], names: list[str] = (), share: float = 0.0
) -> list[LoraUse]:
    """The LoRAs that are this character's, best first. One whose file name
    has the character's name always is; any other must be used mostly with
    them (``OWN_SHARE``) and well beyond how common they are in the library
    (``share``: a character on most images makes every LoRA look theirs).
    Named ones first, then confirmed weight, prompted weight, count. Pure."""
    words = name_words(list(names))

    def named(u: LoraUse) -> bool:
        return any(w in _squash(u.stem) for w in words)

    def own(u: LoraUse) -> bool:
        if u.total <= 0:
            return False
        here = u.images / u.total
        return u.images >= MIN_IMAGES and here >= OWN_SHARE and here >= 2 * share

    found = [u for u in uses if named(u) or own(u)]
    return sorted(
        found,
        key=lambda u: (not named(u), -u.confirmed, -u.prompted, -u.images, u.stem),
    )


def split_signature(sig: list[str]) -> tuple[list[str], list[str]]:
    """Signature tags as (identity, outfit): body features are identity,
    attire the outfit; scene, pose and expression tags are neither. Pure."""
    identity = [s for s in sig if attire.is_identity(s)][:IDENTITY_LIMIT]
    outfit = [s for s in sig if attire.is_attire(s)][:OUTFIT_LIMIT]
    return identity, outfit


def apply_edits(
    identity: list[str],
    candidates: list[LoraUse],
    edit: dict[str, Any] | None,
    added: list[str] = (),
) -> tuple[list[dict], str | None, float | None, bool]:
    """Identity chips (computed ones with their dropped flag, then the ones
    the user added), the LoRA stem and strength, and whether the LoRA is the
    user's choice. Pure."""
    edit = edit or {}
    dropped = set(edit.get("dropped") or [])
    chips = [{"tag": s, "dropped": s in dropped, "added": False} for s in identity]
    have = set(identity)
    chips += [
        {"tag": a, "dropped": False, "added": True}
        for a in dict.fromkeys(added)
        if a not in have
    ]
    forced = edit.get("lora")
    if forced is None:
        stem = candidates[0].stem if candidates else None
    else:
        stem = forced or None
    usual = next((c.strength for c in candidates if c.stem == stem), None)
    strength = edit.get("strength")
    if strength is None:
        strength = usual if usual is not None else DEFAULT_STRENGTH
    return chips, stem, (round(strength, 2) if stem else None), forced is not None


class RecipeError(ValueError):
    pass


async def _edit(key: str) -> dict[str, Any] | None:
    async with async_conn() as conn:
        row = (
            await conn.execute(
                sa.select(t.recipe_edits).where(t.recipe_edits.c.tag == key)
            )
        ).first()
    return dict(row._mapping) if row else None


async def _gender(key: str) -> str | None:
    async with async_conn() as conn:
        return (
            await conn.execute(
                sa.select(t.recipe_genders.c.gender).where(
                    t.recipe_genders.c.tag == key
                )
            )
        ).scalar()


async def _added(key: str) -> list[str]:
    async with async_conn() as conn:
        tags = (
            await conn.execute(
                sa.select(t.recipe_additions.c.tags).where(
                    t.recipe_additions.c.tag == key
                )
            )
        ).scalar()
    return [x for x in tags or [] if isinstance(x, str)]


async def _uses(names: list[str]) -> list[LoraUse]:
    it, il, im = t.image_tags, t.image_loras, t.images
    ids = tag_detail.image_ids(names)
    prompted = (
        sa.select(it.c.image_id)
        .where(it.c.base.in_(names), it.c.tag.like(f"{tag_kinds.PROMPT_PREFIX}%"))
        .distinct()
        .scalar_subquery()
    )
    confirmed = (
        sa.select(it.c.image_id)
        .where(
            it.c.base.in_(names),
            ~it.c.tag.like(f"{tag_kinds.PROMPT_PREFIX}%"),
            ~it.c.tag.like(f"{tag_kinds.MANUAL_PREFIX}%"),
        )
        .distinct()
        .scalar_subquery()
    )
    weight = 1 + sa.func.coalesce(im.c.score, 0)
    is_p = il.c.image_id.in_(prompted)
    is_c = sa.and_(is_p, il.c.image_id.in_(confirmed))
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(
                    il.c.name,
                    sa.func.count().label("images"),
                    sa.func.sum(sa.case((is_c, weight), else_=0)).label("confirmed"),
                    sa.func.sum(sa.case((is_p, weight), else_=0)).label("prompted"),
                    sa.func.avg(sa.case((is_c, il.c.strength))).label("s_conf"),
                    sa.func.avg(il.c.strength).label("s_all"),
                )
                .select_from(il.join(im, im.c._id == il.c.image_id))
                .where(il.c.image_id.in_(ids))
                .group_by(il.c.name)
            )
        ).fetchall()
        if not rows:
            return []
        totals = dict(
            (
                await conn.execute(
                    sa.select(il.c.name, sa.func.count())
                    .select_from(il.join(im, im.c._id == il.c.image_id))
                    .where(
                        il.c.name.in_([r.name for r in rows]),
                        image_visibility.not_quarantined(),
                    )
                    .group_by(il.c.name)
                )
            ).fetchall()
        )
    return [
        LoraUse(
            stem=r.name,
            images=r.images,
            total=totals.get(r.name, r.images),
            confirmed=float(r.confirmed or 0),
            prompted=float(r.prompted or 0),
            strength=r.s_conf if r.s_conf is not None else r.s_all,
        )
        for r in rows
    ]


async def character_key(tag: str) -> tuple[str, list[str], dict, list] | None:
    """``characters._named`` for a character in the library (or made by
    hand); None when ``tag`` isn't one."""
    key, names, key_of, rows = await characters._named(tag)
    if key not in key_of and not await characters.is_made(key, rows):
        return None
    return key, names, key_of, rows


async def character_keys(tags: list[str]) -> list[str]:
    """The page keys of those of ``tags`` that are characters (any of their
    names, or made by hand), each once, in order: :func:`character_key` for
    many, reading the library's characters once."""
    _, key_of, rows = await characters.grouped()
    keys = []
    for tag in tags:
        key = key_of.get(tag, tag)
        if key in key_of or await characters.is_made(key, rows):
            keys.append(key)
    return list(dict.fromkeys(keys))


async def wardrobe(tag: str) -> dict | None:
    """Just the default outfit of ``tag``'s recipe (no LoRA or file work):
    ``tag`` (page key), ``names``, ``count`` and ``outfit``. Kept until the
    next tag write (every outfit call and image view asks); each call gets
    its own lists."""
    gen = tag_index.current_generation()  # before reading what it is made of
    vocab = await tag_categories.load()
    cached = tag_index.read_derived(f"wardrobe:{tag}")
    if cached is None or cached[0] is not vocab:
        found = await character_key(tag)
        if found is None:
            return None
        key, names, key_of, rows = found
        look = await characters.look_of(gen, key, names, key_of, rows)
        cached = (
            vocab,
            (key, tuple(names), look.images, tuple(_split(look)[1])),
        )
        tag_index.store_derived(f"wardrobe:{tag}", gen, cached)
    key, names, count, outfit = cached[1]
    return {"tag": key, "names": list(names), "count": count, "outfit": list(outfit)}


def _split(look: characters.Look) -> tuple[list[str], list[str]]:
    return split_signature([tag for tag, _ in look.signature])


async def recipe(tag: str) -> dict | None:
    """The Character block for ``tag`` (any of the character's names), or
    ``None`` when it isn't a character in the library."""
    gen = tag_index.current_generation()
    found = await character_key(tag)
    if found is None:
        return None
    key, names, key_of, rows = found
    look = await characters.look_of(gen, key, names, key_of, rows)
    count, sig_images, read = look.images, look.counted, look.gender
    set_gender = await _gender(key)
    identity, outfit = _split(look)
    async with async_conn() as conn:
        total = await tag_detail.visible_count(conn)
    candidates = lora_candidates(
        await _uses(names), names, count / total if total else 0.0
    )
    edit = await _edit(key)
    chips, stem, strength, forced = apply_edits(
        identity, candidates, edit, await _added(key)
    )
    files = await _files([c.stem for c in candidates] + ([stem] if stem else []))
    used = {c.stem: c for c in candidates}
    return {
        "tag": key,
        "aliases": names[1:],
        "count": count,
        "identity": chips,
        # The images identity was read from: few means it's a guess.
        "identity_images": sig_images,
        # girl / boy / other: the user's, else from their images' count
        # tags (``gender_read``); None when unclear and not set.
        "gender": set_gender or read,
        "gender_read": read,
        "gender_set": set_gender is not None,
        "outfit": outfit,
        "lora": None
        if stem is None
        else {
            "stem": stem,
            "file": files.get(stem),
            "strength": strength,
            "images": used[stem].images if stem in used else 0,
        },
        "lora_edited": forced,
        "strength_edited": bool(edit and edit.get("strength") is not None),
        "candidates": [
            {
                "stem": c.stem,
                "file": files.get(c.stem),
                "images": c.images,
                "strength": None if c.strength is None else round(c.strength, 2),
            }
            for c in candidates
        ],
    }


async def _files(stems: list[str]) -> dict[str, str | None]:
    """Each stem's installed file (None: not installed, or two files share
    it and no pick was made)."""
    async with async_conn() as conn:
        rows = (
            await conn.execute(sa.select(t.lora_choices.c.stem, t.lora_choices.c.name))
        ).fetchall()
    loras = (await comfy_models.installed())["lora"]
    table = comfy_models.match_table(
        [(s, 0) for s in dict.fromkeys(stems)], loras, {r.stem: r.name for r in rows}
    )
    return {r["stem"]: r["name"] for r in table}


def clean(patch: dict) -> dict:
    """A recipe edit from the API. ``dropped`` a list of tags; ``added`` the
    identity tags the user added (replaces the list); ``lora`` a stem
    or file name ("" = no LoRA, null = back to the computed pick);
    ``strength`` a number or null; ``gender`` girl, boy or other, or null
    (back to the one their images say)."""
    out: dict[str, Any] = {}
    if "gender" in patch:
        g = patch["gender"]
        if g is not None and g not in characters.GENDERS:
            raise RecipeError("gender must be girl, boy, other or null")
        out["gender"] = g
    if "dropped" in patch:
        d = patch["dropped"]
        if not isinstance(d, list) or not all(isinstance(x, str) for x in d):
            raise RecipeError("dropped must be a list of tags")
        out["dropped"] = sorted({x for x in d if x.strip()})
    if "added" in patch:
        a = patch["added"]
        if not isinstance(a, list) or not all(isinstance(x, str) for x in a):
            raise RecipeError("added must be a list of tags")
        out["added"] = list(dict.fromkeys(canonical_tag(x) for x in a if x.strip()))[
            :40
        ]
    if "lora" in patch:
        lo = patch["lora"]
        if lo is not None and not isinstance(lo, str):
            raise RecipeError('lora must be a name, "" or null')
        out["lora"] = None if lo is None else (lora_stem(lo) if lo.strip() else "")
    if "strength" in patch:
        s = patch["strength"]
        if s is not None and (
            isinstance(s, bool) or not isinstance(s, (int, float)) or not -4 <= s <= 4
        ):
            raise RecipeError("strength must be a number from -4 to 4, or null")
        out["strength"] = None if s is None else float(s)
    return out


async def update(tag: str, patch: dict) -> dict | None:
    found = await character_key(tag)
    if found is None:
        return None
    key = found[0]
    values = clean(patch)
    added = values.pop("added", None)
    has_gender = "gender" in values
    gender = values.pop("gender", None)
    now = time.time()
    async with async_tx() as conn:
        if has_gender:
            g = t.recipe_genders
            if gender is None:
                await conn.execute(sa.delete(g).where(g.c.tag == key))
            else:
                row = {"gender": gender, "updated_at": now}
                stmt = sqlite_insert(g).values(tag=key, **row)
                await conn.execute(
                    stmt.on_conflict_do_update(index_elements=["tag"], set_=row)
                )
        if values:
            values["updated_at"] = now
            stmt = sqlite_insert(t.recipe_edits).values(tag=key, **values)
            await conn.execute(
                stmt.on_conflict_do_update(index_elements=["tag"], set_=values)
            )
        if added is not None:
            row = {"tags": added, "updated_at": now}
            stmt = sqlite_insert(t.recipe_additions).values(tag=key, **row)
            await conn.execute(
                stmt.on_conflict_do_update(index_elements=["tag"], set_=row)
            )
    return await recipe(key)
