"""Tag kinds: the pure vocabulary of how a stored tag names its source.

One ``tags`` array holds three kinds of tag, told apart by prefix:

- AI tags     : unprefixed (``1girl``)
- Manual tags: ``manual:``-prefixed (``manual:favourite``)
- Prompt tags: ``prompt:``-prefixed (``prompt:masterpiece``)

plus the search-only ``any:<base>`` marker the gallery emits. Every module
that reads or matches tags uses these helpers; only
:mod:`services.image_tags` writes them. No database imports: this module is
safe for anything to import, which is what keeps the tag index and the
writer free of an import cycle.
"""

from __future__ import annotations

from .tag_names import canonical_name

MANUAL_PREFIX = "manual:"
PROMPT_PREFIX = "prompt:"
# Gallery-search sentinel: ``any:<base>`` is not a stored tag kind but a *query*
# marker the gallery tag search emits. It means "match this text from any source"
# (AI, manual or prompt). Only the query builder interprets it.
ANY_PREFIX = "any:"


def is_manual(tag: str) -> bool:
    return tag.startswith(MANUAL_PREFIX)


def to_manual(tag: str) -> str:
    """Return ``tag`` with the manual prefix, idempotently."""
    return tag if is_manual(tag) else f"{MANUAL_PREFIX}{tag}"


def is_prompt(tag: str) -> bool:
    return tag.startswith(PROMPT_PREFIX)


def to_prompt(tag: str) -> str:
    """Return ``tag`` with the prompt prefix, idempotently."""
    return tag if is_prompt(tag) else f"{PROMPT_PREFIX}{tag}"


def base_of(tag: str) -> str:
    """Strip the kind prefix so the three sources of a tag share a ``base``."""
    if is_manual(tag):
        return tag[len(MANUAL_PREFIX) :]
    if is_prompt(tag):
        return tag[len(PROMPT_PREFIX) :]
    return tag


def canonical_tag(tag: str) -> str:
    """A stored or searched tag in canonical spelling: its kind prefix (manual,
    prompt, or the search-only ``any:``) kept, the name after it canonicalized
    (:func:`services.tag_names.canonical_name`). Idempotent."""
    for prefix in (MANUAL_PREFIX, PROMPT_PREFIX, ANY_PREFIX):
        if tag.startswith(prefix):
            return prefix + canonical_name(tag[len(prefix) :])
    return canonical_name(tag)


def is_any(tag: str) -> bool:
    return tag.startswith(ANY_PREFIX)


def any_variants(tag: str) -> list[str]:
    """Concrete tag ids an ``any:<base>`` selection should match: the bare AI
    tag plus its manual/prompt-prefixed siblings."""
    base = tag[len(ANY_PREFIX) :]
    return [base, to_manual(base), to_prompt(base)]


def expand_search_tag(tag: str) -> list[str]:
    """Tag ids a single selected search entry matches. An ``any:`` entry fans out
    to all sources; any other entry matches itself exactly."""
    return any_variants(tag) if is_any(tag) else [tag]


def tag_match_groups(tags: list[str], logic: str) -> list[list[str]]:
    """Translate selected search entries into AND-of-EXISTS groups for SQL.

    Each returned group is a list of acceptable tag ids; the caller requires the
    image to carry at least one id from *every* group (one ``EXISTS`` per group,
    all ANDed).

    - OR  → a single group: the union of every entry's variants (one EXISTS, IN).
    - AND → one group per entry (the image must satisfy each entry).
    """
    if logic == "or":
        flat: list[str] = []
        seen: set[str] = set()
        for entry in tags:
            for v in expand_search_tag(entry):
                if v not in seen:
                    seen.add(v)
                    flat.append(v)
        return [flat]
    return [expand_search_tag(entry) for entry in tags]


def excluded_prefixes(*, include_manual: bool, include_prompt: bool) -> list[str]:
    """Tag prefixes the tag browser should hide. Default browse is AI-only."""
    excluded: list[str] = []
    if not include_manual:
        excluded.append(MANUAL_PREFIX)
    if not include_prompt:
        excluded.append(PROMPT_PREFIX)
    return excluded


def recompute_flags(tags: list[str]) -> dict[str, bool]:
    """Derive the three summary flags from a tag list.

    ``has_ai_tags`` = "has a tag with no kind prefix" (neither manual nor prompt).
    ``has_tags``    = "has a curatable tag" (any non-prompt tag).
    """
    return {
        "has_tags": any(not is_prompt(x) for x in tags),
        "has_ai_tags": any(not is_manual(x) and not is_prompt(x) for x in tags),
        "has_prompt_tags": any(is_prompt(x) for x in tags),
    }
