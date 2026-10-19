"""Best-effort prompt parsing: prompt text -> classified pieces.

Prompts are hand-written and only loosely structured. Commas go missing
between weighted groups (``(a:1.05)(b:1.25)``), brackets open in one piece and
close in another, settings lines get pasted in, sentences sit beside tags. So
this never rejects input and never assumes the text is well formed: it reads
the prompt the way ComfyUI / A1111 do, one character at a time, tracking
emphasis groups, and does the best it can with whatever it finds. A missing
``)`` closes at the end, a stray ``)`` is just a boundary.

Three passes, all pure:

1. **Scan** (:func:`_scan`): walk the text, cutting raw pieces at separators
   (comma, newline, ``|``, ``BREAK`` / ``AND``) *and* at the edges of emphasis
   groups. Emphasis brackets and ``:weight`` suffixes describe a piece; they
   are never part of it. A ``(...)`` straight after text, unweighted and short,
   is a Danbooru qualifier instead (``hu tao (genshin impact)``) and stays in
   the piece. ``\\(`` escapes are literal. ``<lora:...>`` tokens pass whole.
2. **Clean** each piece: whitespace collapsed, stray edge punctuation and a
   trailing ``:weight`` dropped, lowercased.
3. **Classify** (:func:`classify`): ``tag``, ``prose`` (a sentence fragment:
   kept in the prompt text, never a tag) or ``noise`` (leaked settings, lone
   joiners, bare numbers).

The original prompt is always kept verbatim elsewhere; this only decides what
becomes a prompt tag, so it can be improved and simply re-run (reprojection).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .tag_names import KAOMOJIS

_SEPARATORS = {",", "\n", "|"}
_OPEN = {"(": ")", "[": "]", "{": "}"}
_CLOSE = {")", "]", "}"}

# A ``:weight`` suffix (``tag:1.2``) or a weight-only fragment (``:1.2``).
_WEIGHT_TAIL = re.compile(r"\s*:\s*-?\d*\.?\d+\s*$")
# A1111 keywords: ``BREAK`` starts a new chunk, ``AND`` composes prompts.
# Uppercase only; lowercase "and" is just a word.
_KEYWORD = re.compile(r"\b(?:BREAK|AND)\b")
_EDGE_PUNCT = " \t.;:!?\"'`"

# Pieces that are generation settings pasted into the prompt, not content.
_SETTINGS_KEY = re.compile(
    r"^(?:vae|steps|sampler|scheduler|cfg(?: scale)?|seed|size|model(?: hash)?|"
    r"clip skip|denoising strength|hires (?:upscale|steps|upscaler)|"
    r"lora hashes|version|ensd|width|height)\s*:"
)
# A stray "Negative prompt:" marker (a paste slip): drop the marker, keep the
# text after it.
_NEG_MARKER = re.compile(r"\bnegative prompt\s*:\s*")

# Words that alone are never a tag: leftovers between groups, e.g. the "and"
# in ``(a) and (b)``.
_JOINERS = {"and", "or", "with", "a", "an", "the", "of", "in", "on", "by", "-"}

# Prose markers (see :func:`is_prose`). Evaluated 2026-10-19 against the WD
# tagger's 10.8k Danbooru vocabulary: 2 false positives.
_PROSE_WORDS = {
    "a", "an", "the", "she", "he", "her", "his", "they", "their", "is", "are",
    "was", "has", "wears", "stands", "sits", "sitting", "standing",
}  # fmt: skip
_ABBREV = {"st", "jr", "sr", "dr", "mr", "mrs", "ms", "vs", "ver", "vol", "no", "feat"}
_SENTENCE_END = re.compile(r"\b([a-z]{2,})\.(?=\s|$)")
# Danbooru emoticon tags (from the WD tagger vocabulary) plus kaomoji. They
# are all punctuation, so they are matched whole before any bracket, colon or
# separator logic can take them apart.
_EMOTICONS = KAOMOJIS | {
    ":d", ":o", ":3", ";d", ":<", ":p", ":q", ":t", ";)", ":>", ">:)", ":/",
    ";o", "d:", ":|", "3:", ";p", ">:(", ":>=", ";q", ":i", ";3", ":x", ";(",
    ">o<", "^^^", "+++", "\\m/", "\\o/", "\\n/", "\\||/", "...", "...?",
    "?", "!", "!?", "!!", "??",
}  # fmt: skip
# Leading joiners left on a piece by run-on prose ("and black thigh-highs").
_LEAD_JOINER = re.compile(r"^(?:and|or)\s+")
_QUALIFIER = re.compile(r"\([^()]*\)")
# What follows a weight colon: a number, then a group close, comma or the end.
_WEIGHT_AHEAD = re.compile(r"-?\d*\.?\d+\s*(?:[)\]},]|$)")


@dataclass(frozen=True)
class Piece:
    text: str
    kind: str  # "tag" | "prose" | "noise"


def _qualifier_end(text: str, i: int) -> int | None:
    """If the ``(`` at ``i`` opens a Danbooru qualifier, the index just past
    its ``)``; else ``None``. A qualifier is unweighted, flat (no nested
    brackets or separators) and short: ``(genshin impact)``, ``(cosplay)``."""
    j = i + 1
    while j < len(text):
        ch = text[j]
        if ch == ")":
            inner = text[i + 1 : j]
            if not inner.strip() or ":" in inner or len(inner.split()) > 6:
                return None
            return j + 1
        if ch in _SEPARATORS or ch in _OPEN or ch in _CLOSE or ch == "\\":
            return None
        j += 1
    return None


def _scan(text: str) -> list[str]:
    """Raw pieces of ``text``, cut at separators and emphasis-group edges."""
    text = _KEYWORD.sub(",", text)
    pieces: list[str] = []
    buf: list[str] = []
    # Open bracket kinds, innermost last.
    stack: list[str] = []

    def flush() -> None:
        if buf:
            pieces.append("".join(buf))
            buf.clear()

    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if not "".join(buf).strip():
            # At a piece start: an emoticon tag is taken whole.
            end = min(
                (k for k in (text.find(",", i), text.find("\n", i)) if k >= 0),
                default=n,
            )
            if text[i:end].strip().lower() in _EMOTICONS:
                flush()
                pieces.append(text[i:end])
                i = end
                continue
        if ch == "\\" and i + 1 < n:
            # Escaped bracket (or anything): literal text.
            buf.append(text[i + 1])
            i += 2
            continue
        if ch == "<":
            # <lora:name:0.8> / <embedding:x>: one opaque piece.
            end = text.find(">", i)
            end = n if end < 0 else end + 1
            flush()
            pieces.append(text[i:end])
            i = end
            continue
        if ch in _SEPARATORS:
            flush()
            i += 1
            continue
        if ch == "(" and "".join(buf).strip():
            end = _qualifier_end(text, i)
            if end is not None:
                buf.append(text[i:end])
                i = end
                continue
        if ch in _OPEN:
            flush()
            stack.append(ch)
            i += 1
            continue
        if ch in _CLOSE:
            # Closes a group, or is a stray: a boundary either way.
            flush()
            if stack:
                stack.pop()
            i += 1
            continue
        if ch == ":" and stack and stack[-1] == "[" and "".join(buf).strip():
            # Inside ``[...]``, a non-weight colon is A1111 prompt editing
            # (``[from:to:0.5]``): the two sides are separate pieces. A
            # weight colon is left for _clean to strip. Inside ``(...)`` a
            # colon is text (``(artist:name)``) or a weight.
            rest = text[i + 1 :].lstrip()
            if not _WEIGHT_AHEAD.match(rest):
                flush()
                i += 1
                continue
        buf.append(ch)
        i += 1
    flush()
    return pieces


def _clean(raw: str) -> str:
    s = re.sub(r"\s+", " ", raw).strip().lower()
    if s.startswith("<") or s in _EMOTICONS:
        return s
    # "(denpa onna to seishun otoko )" and "(... otoko)" are one qualifier.
    s = re.sub(r"\(\s+", "(", re.sub(r"\s+\)", ")", s))
    s = _LEAD_JOINER.sub("", s)
    s = _NEG_MARKER.sub("", s)
    if _SETTINGS_KEY.match(s):
        # "steps: 20" is a setting, not a tag weighted 20; classify drops it.
        return s
    s = _WEIGHT_TAIL.sub("", s)
    return s.strip(_EDGE_PUNCT)


def is_prose(text: str) -> bool:
    """A sentence fragment rather than a tag. Words inside ``(...)``
    qualifiers don't count, so long character tags stay tags. Prose is 9+
    words, or 5+ words with a sentence break (abbreviations like ``st.``
    excepted) or a prose word (article, pronoun, finite verb). Pass the text
    before edge punctuation is trimmed, so a closing period still counts."""
    text = text.strip().lower()
    words = _QUALIFIER.sub(" ", text).split()
    if len(words) >= 9:
        return True
    if len(words) < 5:
        return False
    if any(m.group(1) not in _ABBREV for m in _SENTENCE_END.finditer(text)):
        return True
    return any(w.strip(".,!?'\"") in _PROSE_WORDS for w in words)


def classify(text: str, raw: str | None = None) -> str:
    """Kind of a cleaned piece; ``raw`` (the piece before cleaning) lets the
    prose check see a sentence's closing period."""
    if text.startswith("<") or text in _EMOTICONS:
        return "tag"
    if not text or text in _JOINERS or not re.search(r"[^\W_]", text):
        return "noise"  # empty, a lone joiner, or only punctuation
    if re.fullmatch(r"-?\d*\.\d+", text):
        return "noise"  # a stray weight (``1.15``); integers (``1990``) stay
    if _SETTINGS_KEY.match(text):
        return "noise"
    return "prose" if is_prose(raw if raw is not None else text) else "tag"


def parse_prompt(text: str | None) -> list[Piece]:
    """Every piece of ``text`` with its kind, in order. Never raises."""
    if not text:
        return []
    out: list[Piece] = []
    for raw in _scan(text):
        s = _clean(raw)
        if s or raw.strip():
            out.append(Piece(s, classify(s, raw)))
    return out
