"""Prompt blocks -> ComfyUI prompt text, and the batch auto-name. Pure.

Positive = Base + Character + Outfit + Extra; negative = Base + Extra. Base is
free text written as-is; the chip blocks hold canonical tag names (underscores)
or ``embedding:name`` words. Mirrors the frontend's ``lib/compose.ts`` (which
previews the same text) and ``lib/tags.ts`` ``toPromptText`` escaping.
"""

from __future__ import annotations

import re
from typing import Iterable

from .prompt_parse import parse_prompt
from .tag_names import display_tag

EMBEDDING_PREFIX = "embedding:"
_PAREN = re.compile(r"([()])")


def is_embedding(word: str) -> bool:
    return word.startswith(EMBEDDING_PREFIX)


def _chip_text(word: str) -> str:
    # Embedding names are file names, sent untouched; tag parentheses are
    # escaped so ComfyUI doesn't read them as weights.
    return word if is_embedding(word) else _PAREN.sub(r"\\\1", word)


def compose_parts(items: Iterable[str | Iterable[str]]) -> str:
    """Layers in order, comma-joined: a string is free text written as is
    (trailing comma dropped), any other iterable a chip block (tags escaped, a
    chip already written in an earlier block written once)."""
    parts: list[str] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, str):
            text = item.strip().rstrip(",").strip()
            if text:
                parts.append(text)
            continue
        for word in item:
            word = word.strip()
            if not word or word in seen:
                continue
            seen.add(word)
            parts.append(_chip_text(word))
    return ", ".join(parts)


def compose(base: str, *chip_blocks: Iterable[str]) -> str:
    """Base text, then each chip block in order (batches from before the
    layered composer)."""
    return compose_parts([base or "", *chip_blocks])


def prompt_terms(text: str, limit: int = 2) -> list[str]:
    """The first tags of a prompt, for a batch's auto name: read by
    :func:`parse_prompt`, so weights, brackets, escapes, embeddings and LoRA
    tokens are handled as everywhere else."""
    tags = [p.text for p in parse_prompt(text) if p.kind == "tag"]
    return [display_tag(t) for t in tags[:limit]]


def display(word: str) -> str:
    """Tag display form for names: underscores read as spaces."""
    if is_embedding(word):
        return word[len(EMBEDDING_PREFIX) :]
    return display_tag(word)


def auto_name(
    *,
    number: int,
    generator: str,
    extra: Iterable[str] = (),
    character: str | None = None,
    outfit: str | None = None,
) -> str:
    """ "Character, Outfit"; without a character, "Generator, first two Extra
    tags" (the layered composer passes the Prompt's first terms,
    :func:`prompt_terms`); else "Batch <n>"."""
    if character:
        return ", ".join(p for p in (display(character), outfit) if p)
    words = [display(w) for w in extra if w.strip() and not is_embedding(w)][:2]
    if words:
        return ", ".join([generator, *words])
    return f"Batch {number}"
