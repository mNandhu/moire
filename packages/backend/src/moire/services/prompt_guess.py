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
candidate texts, with where each sits so a guess can be pinned.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable, NamedTuple

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
    count, names = _piece_names(text)
    if count < MIN_PIECES:
        return None
    return len(names & keywords.positive), len(names & keywords.negative)


# Every candidate text of every graph is scored, and a library repeats its
# prompts, so the keyword forms of a text are worth keeping. Pure in `text`.
@lru_cache(maxsize=4096)
def _piece_names(text: str) -> tuple[int, frozenset[str]]:
    """How many tag/prose pieces ``text`` has, and their keyword forms."""
    pieces = [p for p in parse_prompt(text) if p.kind in ("tag", "prose")]
    return len(pieces), frozenset(keyword_key(p.text) for p in pieces)


class Candidate(NamedTuple):
    """A text in the graph. ``shown``: a display node showed it (it ran).
    ``path``: where it sits in the raw doc, as a ruleset pin would name it
    (``prompt.32.inputs.text_0``), or ``None`` when unknown."""

    text: str
    shown: bool = False
    path: str | None = None


def pick(
    candidates: Iterable[Candidate],
    keywords: Keywords,
    *,
    prompt: str | None = None,
    negative: str | None = None,
) -> dict[str, Candidate]:
    """The best ``"prompt"`` and ``"negative"`` candidates, either missing when
    nothing qualifies. ``prompt`` / ``negative`` are what is already known: a
    side that is known isn't guessed, and the other side's guess can't be the
    same text."""
    # The same text often appears twice (a widget and the display of it);
    # score it once, as shown if either copy was, at the first known path.
    seen: dict[str, Candidate] = {}
    for c in candidates:
        if not c.text.strip():
            continue
        prev = seen.get(c.text)
        seen[c.text] = (
            c
            if prev is None
            else Candidate(c.text, prev.shown or c.shown, prev.path or c.path)
        )
    best: dict[str, tuple[tuple[bool, int, int], Candidate]] = {}
    for c in seen.values():
        hits = _hits(c.text, keywords)
        if hits is None:
            continue
        pos, neg = hits
        for side, hit, other, known, taken in (
            ("prompt", pos, neg, prompt, negative),
            ("negative", neg, pos, negative, prompt),
        ):
            if known or hit <= other or c.text == taken:
                continue
            rank = (c.shown, hit, len(c.text))
            if side not in best or rank > best[side][0]:
                best[side] = (rank, c)
    return {side: c for side, (_rank, c) in best.items()}
