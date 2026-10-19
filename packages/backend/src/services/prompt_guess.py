"""Guessing a prompt by its keywords, for graphs the structural walk can't read.

Some ComfyUI workflows never wire a prompt into a local sampler (a remote
queue, a prompt assembled by custom nodes), so ``parse_comfyui`` finds no
prompt. Their text still sits somewhere in the graph. Quality boilerplate
gives it away: a positive prompt says ``masterpiece``, a negative one says
``worst quality``. Every text in the graph is scored by how many of the
user's keywords it contains, and the best one per side wins:

- a text is a positive candidate when it has more positive hits than
  negative ones (and the reverse), so one text never fills both fields;
- text a display node showed (what actually ran) beats a static widget,
  then more hits, then the longer text (a fragment loses to the full prompt).

Only fields the graph walk and the user's pins left empty are filled, and
``gen.guessed`` names them so the UI can say so. Pure: callers supply the
candidate texts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .prompt_parse import parse_prompt
from .tag_names import canonical_name

DEFAULT_POSITIVE: tuple[str, ...] = (
    "masterpiece",
    "best_quality",
    "high_quality",
    "amazing_quality",
    "absurdres",
    "score_9",
    "score_8_up",
)
DEFAULT_NEGATIVE: tuple[str, ...] = (
    "worst_quality",
    "low_quality",
    "bad_quality",
    "lowres",
    "bad_anatomy",
    "bad_hands",
    "blurry",
    "score_4",
    "score_5",
)

MAX_KEYWORDS = 100
MAX_LEN = 100
# Fewer prompt pieces than this is a name, a path or a setting, not a prompt.
MIN_PIECES = 3


@dataclass(frozen=True)
class Keywords:
    positive: frozenset[str]
    negative: frozenset[str]


DEFAULT_KEYWORDS = Keywords(frozenset(DEFAULT_POSITIVE), frozenset(DEFAULT_NEGATIVE))


def keyword_key(entry: str) -> str:
    """The form a keyword is stored and matched in: canonical, lowercase."""
    return canonical_name(entry).lower()


def clean_keywords(entries: Any) -> list[str]:
    """Canonical, non-empty, de-duplicated and capped. Raises ValueError for
    anything that isn't a list of strings."""
    if not isinstance(entries, list) or not all(isinstance(e, str) for e in entries):
        raise ValueError("keywords must be a list of strings")
    out: list[str] = []
    for raw in entries:
        key = keyword_key(raw)
        if not key or len(key) > MAX_LEN or key in out:
            continue
        out.append(key)
        if len(out) >= MAX_KEYWORDS:
            break
    return out


def _hits(text: str, keywords: Keywords) -> tuple[int, int] | None:
    pieces = [p for p in parse_prompt(text) if p.kind in ("tag", "prose")]
    if len(pieces) < MIN_PIECES:
        return None
    names = {keyword_key(p.text) for p in pieces}
    return len(names & keywords.positive), len(names & keywords.negative)


def pick(
    candidates: Iterable[tuple[str, bool]],
    keywords: Keywords,
    *,
    prompt: str | None = None,
    negative: str | None = None,
) -> tuple[str | None, str | None]:
    """The best positive and negative text among ``(text, shown)`` candidates.
    ``prompt`` / ``negative`` are what is already known: a side that is known
    isn't guessed, and the other side's guess can't be the same text."""
    best: dict[str, tuple[tuple[bool, int, int], str]] = {}
    seen: dict[str, bool] = {}
    for text, shown in candidates:
        # The same text often appears twice (a widget and the display of it);
        # score it once, as shown if either copy was.
        if text.strip():
            seen[text] = seen.get(text, False) or shown
    for text, shown in seen.items():
        hits = _hits(text, keywords)
        if hits is None:
            continue
        pos, neg = hits
        for side, hit, other, taken in (
            ("prompt", pos, neg, negative),
            ("negative", neg, pos, prompt),
        ):
            if hit <= other or text == taken:
                continue
            rank = (shown, hit, len(text))
            if side not in best or rank > best[side][0]:
                best[side] = (rank, text)
    return (
        None if prompt else best.get("prompt", (None, None))[1],
        None if negative else best.get("negative", (None, None))[1],
    )
