"""Suggested activation words for a style LoRA (:mod:`services.lora_presets`).

Suggested words come from two places: the LoRA file's training tags (its
safetensors metadata, read through ComfyUI) and the user's own images made
with that LoRA (prompt words that come with it far more often than without).
The library counts distinct prompts, not images: a batch of four from one
prompt says nothing about which of its words belong to the LoRA.
"""

from __future__ import annotations

import json
import time
from typing import Any

import sqlalchemy as sa

from ..database.db import async_conn
from ..database import schema as t
from . import image_tags, image_visibility, tag_index, tag_kinds
from .comfy_client import ComfyClient, ComfyError, ComfyUnreachable
from .model_names import model_stem

# A library word must be in at least this share of the LoRA's prompts, and
# this many times likelier there than across the library.
MIN_SHARE = 0.5
MIN_LIFT = 3.0
MIN_PROMPTS = 3
# A training tag already in this share of the library's prompts (1girl,
# solo) is a description, not something the LoRA needs.
COMMON = 0.05
# Training tags kept: in at least this share of the most frequent one's
# captions.
FREQUENT = 0.5
LIMIT = 8


def file_words(meta: dict[str, Any] | None, limit: int = LIMIT) -> list[str]:
    """Trigger words from a LoRA's safetensors metadata: its stated trigger
    phrase first, then the training tags that are in most captions. Pure."""
    if not isinstance(meta, dict):
        return []
    out: list[str] = []
    phrase = meta.get("modelspec.trigger_phrase")
    if isinstance(phrase, str):
        out += [w.strip() for w in phrase.split(",") if w.strip()]
    freq = meta.get("ss_tag_frequency")
    if isinstance(freq, str):
        try:
            freq = json.loads(freq)
        except ValueError:
            freq = None
    counts: dict[str, int] = {}
    if isinstance(freq, dict):
        for tags in freq.values():
            if not isinstance(tags, dict):
                continue
            for tag, n in tags.items():
                word = str(tag).strip()
                if word and isinstance(n, (int, float)):
                    counts[word] = counts.get(word, 0) + int(n)
    # A trigger is in (nearly) every caption; a description tag (sky, shirt)
    # only in some.
    top = max(counts.values(), default=0)
    out += sorted(
        (w for w, c in counts.items() if c >= FREQUENT * top), key=lambda w: -counts[w]
    )
    seen: set[str] = set()
    words = []
    for w in out:
        if w.lower() not in seen:
            seen.add(w.lower())
            words.append(w)
    return words[:limit]


def library_words(
    here: dict[str, int],
    n: int,
    everywhere: dict[str, int],
    total: int,
    limit: int = LIMIT,
) -> list[tuple[str, int]]:
    """Prompt words that come with a LoRA: in at least MIN_SHARE of its ``n``
    prompts and MIN_LIFT times likelier there than across ``total``. Most
    prompts first. Pure."""
    if n < MIN_PROMPTS or total <= 0:
        return []
    picked = []
    for word, c in here.items():
        share = c / n
        base = everywhere.get(word, c) / total
        if share >= MIN_SHARE and base > 0 and share / base >= MIN_LIFT:
            picked.append((word, c, share / base))
    picked.sort(key=lambda x: (-x[1], -x[2], x[0]))
    return [(w, c) for w, c, _ in picked[:limit]]


def _prompt_scope():
    """What every library count here shares: the distinct-prompt key (one
    prompt, however many images it made, counts once), the prompt tags
    joined to their images, and the predicate keeping prompt tags of images
    out of quarantine."""
    it, im = t.image_tags, t.images
    key = sa.func.coalesce(im.c.gen_prompt, im.c._id)
    tagged = it.join(im, im.c._id == it.c.image_id)
    prompt = sa.and_(
        it.c.tag.like(f"{tag_kinds.PROMPT_PREFIX}%"),
        image_visibility.not_quarantined(),
    )
    return key, tagged, prompt


# The last total and when it was counted: while tags are being written
# (an AI job, a reprojection) it is reused for up to a minute.
_last_total: tuple[float, int] | None = None
_TOTAL_MIN_AGE = 60.0


async def _prompt_total() -> int:
    """Distinct prompts in the library, kept until the next tag write (but
    counted at most once a minute): every suggestion measures against it,
    and it is a scan of every prompt tag."""
    global _last_total
    gen = tag_index.current_generation()
    cached = tag_index.read_derived("lora-prompt-total")
    if cached is not None:
        return cached
    if _last_total and time.monotonic() - _last_total[0] < _TOTAL_MIN_AGE:
        return _last_total[1]
    key, tagged, prompt = _prompt_scope()
    async with async_conn() as conn:
        n = (
            await conn.execute(
                sa.select(sa.func.count(sa.distinct(key)))
                .select_from(tagged)
                .where(prompt)
            )
        ).scalar_one()
    tag_index.store_derived("lora-prompt-total", gen, n)
    _last_total = (time.monotonic(), n)
    return n


def _key(word: str) -> str:
    """One spelling for comparing words: training tags have spaces, library
    words underscores."""
    return image_tags.canonical_tag(word).lower()


async def _library(stem: str) -> list[tuple[str, int]]:
    il, it, im = t.image_loras, t.image_tags, t.images
    key, tagged, prompt = _prompt_scope()
    ids = (
        sa.select(il.c.image_id)
        .select_from(il.join(im, im.c._id == il.c.image_id))
        .where(il.c.name == stem, image_visibility.not_quarantined())
        .scalar_subquery()
    )
    async with async_conn() as conn:
        n = (
            await conn.execute(
                sa.select(sa.func.count(sa.distinct(key)))
                .select_from(tagged)
                .where(it.c.image_id.in_(ids), prompt)
            )
        ).scalar_one()
        if n < MIN_PROMPTS:
            return []
        here = dict(
            (
                await conn.execute(
                    sa.select(it.c.base, sa.func.count(sa.distinct(key)))
                    .select_from(tagged)
                    .where(it.c.image_id.in_(ids), prompt, it.c.base != "")
                    .group_by(it.c.base)
                )
            ).fetchall()
        )
        common = [w for w, c in here.items() if c / n >= MIN_SHARE]
        if not common:
            return []
        everywhere = dict(
            (
                await conn.execute(
                    sa.select(it.c.base, sa.func.count(sa.distinct(key)))
                    .select_from(tagged)
                    .where(it.c.base.in_(common), prompt)
                    .group_by(it.c.base)
                )
            ).fetchall()
        )
    total = await _prompt_total()
    return library_words({w: here[w] for w in common}, n, everywhere, total)


async def _common(words: list[str], stem: str) -> set[str]:
    """Which of ``words`` (training tags, spaces or underscores) are in at
    least COMMON of the library's prompts made without the LoRA (with it, its
    own trigger is common because the user uses it)."""
    if not words:
        return set()
    it, il = t.image_tags, t.image_loras
    key, tagged, prompt = _prompt_scope()
    without = ~it.c.image_id.in_(
        sa.select(il.c.image_id).where(il.c.name == stem).scalar_subquery()
    )
    bases = {image_tags.canonical_tag(w): w for w in words}
    total = await _prompt_total()
    if not total:
        return set()
    async with async_conn() as conn:
        rows = (
            await conn.execute(
                sa.select(it.c.base, sa.func.count(sa.distinct(key)))
                .select_from(tagged)
                .where(it.c.base.in_(list(bases)), prompt, without)
                .group_by(it.c.base)
            )
        ).fetchall()
    return {bases[b] for b, c in rows if b in bases and c / total >= COMMON}


async def _file(
    client: ComfyClient | None, name: str, describe: bool = False
) -> list[str]:
    if client is None or not name.lower().endswith(".safetensors"):
        return []
    try:
        meta = await client.lora_metadata(name)
    except (ComfyError, ComfyUnreachable):
        return []
    words = file_words(meta, limit=4 * LIMIT)
    if describe:
        return words[:LIMIT]
    # A stated trigger phrase is kept even when common; caption tags are not
    # (a style LoRA's most frequent one is usually 1girl).
    stated = {
        _key(w)
        for w in file_words(
            {"modelspec.trigger_phrase": (meta or {}).get("modelspec.trigger_phrase")}
        )
    }
    common = await _common(
        [w for w in words if _key(w) not in stated], model_stem(name)
    )
    return [w for w in words if w not in common][:LIMIT]


async def suggestions(
    name: str, client: ComfyClient | None, describe: bool = False
) -> list[dict[str, Any]]:
    """Words to offer for the LoRA file ``name``: each with where it came
    from (``file``, ``library``) and, from the library, in how many prompts."""
    lib = await _library(model_stem(name))
    out: dict[str, dict[str, Any]] = {}
    for w in await _file(client, name, describe):
        out[_key(w)] = {"word": w, "sources": ["file"], "prompts": 0}
    for w, c in lib:
        hit = out.get(_key(w))
        if hit:
            hit["sources"].append("library")
            hit["prompts"] = c
        else:
            out[_key(w)] = {"word": w, "sources": ["library"], "prompts": c}
    return list(out.values())
