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
   are never part of it. A short unweighted ``(...)`` glued onto a name with
   no space (``hu_tao_(genshin_impact)``) or escaped (``hu tao \\(genshin
   impact\\)``) is a Danbooru qualifier and stays in the piece; after a space
   it is emphasis, as ComfyUI reads it. Lora / embedding tokens and emoticon
   tags (``:d``, ``>_<``) pass whole.
2. **Clean** each piece: whitespace collapsed, stray edge punctuation and,
   inside a group, a trailing ``:weight`` dropped, lowercased.
3. **Classify** (:func:`classify`): ``tag``, ``prose`` (a sentence fragment:
   kept in the prompt text, never a tag), ``noise`` (leaked settings, lone
   joiners, stray weights) or ``network`` (a ``<lora:...>`` / embedding token,
   recorded as ``gen.loras`` instead of a tag).

The original prompt is always kept verbatim elsewhere; this only decides what
becomes a prompt tag, so it can be improved and simply re-run (reprojection).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from .tag_names import KAOMOJIS

_SEPARATORS = {",", "\n", "|"}
_OPEN = {"(": ")", "[": "]", "{": "}"}
_CLOSE = {")", "]", "}"}

# A ``:weight`` suffix (``tag:1.2``) or a weight-only fragment (``:1.2``).
_WEIGHT_TAIL = re.compile(r"\s*:\s*-?\d*\.?\d+\s*$")
_DECIMAL_WEIGHT_TAIL = re.compile(r"\s*:\s*-?\d*\.\d+\s*$")
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
_EMOTICON_MAX = max(len(e) for e in _EMOTICONS)
# A lora / LyCORIS / hypernetwork / embedding token, closed before the next
# separator. Anything else starting with "<" is plain text.
_NETWORK_TOKEN = re.compile(
    r"<(?:lora|lyco|lycoris|hypernet|embedding|wlr):[^<>,\n]*>", re.IGNORECASE
)
_NETWORK_PREFIX = re.compile(
    r"<(?:lora|lyco|lycoris|hypernet|embedding|wlr):|embedding:", re.IGNORECASE
)
# ComfyUI's textual-inversion syntax: ``embedding:name`` (a file name, maybe
# with folders and extension), optionally weighted ``embedding:name:1.2``
# inside a group. A word of its own, so it starts after a space, separator or
# bracket; the weight is kept on the token, not left behind as a stray number.
EMBEDDING_TOKEN = re.compile(
    r"embedding:([^\s,()\[\]{}<>|:]+)(?::(-?\d*\.?\d+)(?=\s*[)\]},]|\s*$))?",
    re.IGNORECASE,
)
# Leading joiners left on a piece by run-on prose ("and black thigh-highs").
_LEAD_JOINER = re.compile(r"^(?:and|or)\s+")
_QUALIFIER = re.compile(r"\([^()]*\)")
# What follows a weight colon: a number, then a group close, comma or the end.
_WEIGHT_AHEAD = re.compile(r"-?\d*\.?\d+\s*(?:[)\]},]|$)")


@dataclass(frozen=True)
class Piece:
    text: str
    kind: str  # "tag" | "prose" | "noise" | "network"


def _qualifier_end(text: str, i: int) -> int | None:
    """If the ``(`` at ``i`` opens a Danbooru qualifier, the index just past
    its ``)``; else ``None``. A qualifier is unweighted, flat (no nested
    brackets or separators) and short: ``(genshin_impact)``, ``(cosplay)``."""
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


def _keyword_at(text: str, i: int) -> int:
    """Length of a ``BREAK`` / ``AND`` keyword standing alone at ``i``, else 0."""
    for kw in ("BREAK", "AND"):
        j = i + len(kw)
        if (
            text.startswith(kw, i)
            and (i == 0 or not text[i - 1].isalnum())
            and (j == len(text) or not text[j].isalnum())
        ):
            return len(kw)
    return 0


def _emoticon_at(text: str, i: int) -> int:
    """Length of the longest emoticon tag at ``i`` that ends at a boundary
    (separator, space, group close, a ``:weight``, or the end), else 0."""
    n = len(text)
    for length in range(min(_EMOTICON_MAX, n - i), 0, -1):
        if text[i : i + length].lower() not in _EMOTICONS:
            continue
        j = i + length
        if (
            j == n
            or text[j] in _SEPARATORS
            or text[j] in _CLOSE
            or text[j].isspace()
            or (text[j] == ":" and _WEIGHT_AHEAD.match(text[j + 1 :].lstrip()))
        ):
            return length
    return 0


def _scan(text: str) -> list[tuple[str, bool]]:
    """Raw pieces of ``text``, cut at separators and emphasis-group edges,
    each with whether it sat inside a group (only there is ``:n`` a weight)."""
    pieces: list[tuple[str, bool]] = []
    buf: list[str] = []
    # Whether `buf` holds any non-space text (kept as a flag, not re-derived,
    # so the scan stays linear in the prompt length).
    has_text = False
    # Open bracket kinds, innermost last.
    stack: list[str] = []

    def flush() -> None:
        nonlocal has_text
        if buf:
            pieces.append(("".join(buf), bool(stack)))
            buf.clear()
        has_text = False

    def emit(raw: str) -> None:
        flush()
        pieces.append((raw, bool(stack)))

    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if not has_text:
            if ch.isspace():
                i += 1
                continue
            # At a piece start: an emoticon tag is taken whole, before its
            # punctuation can be read as brackets, colons or separators.
            length = _emoticon_at(text, i)
            if length:
                emit(text[i : i + length])
                i += length
                continue
        length = _keyword_at(text, i)
        if length:
            flush()
            i += length
            continue
        if ch == "\\" and i + 1 < n:
            # An escape is literal text (``\(``), except an escaped comma,
            # which still separates: a tag never holds a comma.
            if text[i + 1] == ",":
                flush()
            else:
                buf.append(text[i + 1])
                has_text = True
            i += 2
            continue
        if ch in "eE" and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            # embedding:name: its own piece even mid-run ("x embedding:y z").
            m = EMBEDDING_TOKEN.match(text, i)
            if m:
                emit(m.group(0))
                i = m.end()
                continue
        if ch == "<":
            # <lora:name:0.8> / <embedding:x>: one opaque piece, but only when
            # it really is one. Any other "<" (``<3``, a kaomoji) is text.
            m = _NETWORK_TOKEN.match(text, i)
            if m:
                emit(m.group(0))
                i = m.end()
                continue
        if ch in _SEPARATORS:
            flush()
            i += 1
            continue
        if ch == "(" and has_text and not buf[-1].isspace():
            # Glued straight onto a name (``hu_tao_(genshin_impact)``) is a
            # Danbooru qualifier. After a space it is emphasis, like ComfyUI
            # reads it: ``hu tao (genshin impact)`` is two tags.
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
        if ch == ":" and stack and stack[-1] == "[" and has_text:
            # Inside ``[...]``, a non-weight colon is A1111 prompt editing
            # (``[from:to:0.5]``): the two sides are separate pieces. A
            # weight colon is left for _clean to strip. Inside ``(...)`` a
            # colon is text (``(artist:name)``) or a weight.
            if not _WEIGHT_AHEAD.match(text[i + 1 :].lstrip()):
                flush()
                i += 1
                continue
        buf.append(ch)
        if not ch.isspace():
            has_text = True
        i += 1
    flush()
    return pieces


def _clean(raw: str, in_group: bool) -> str:
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
    # Inside a group ``:n`` is a weight. Outside, only a decimal one is
    # (``smile:1.05``, written without brackets); ``16:9`` and ``12:00`` are
    # text.
    s = (_WEIGHT_TAIL if in_group else _DECIMAL_WEIGHT_TAIL).sub("", s)
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
    if _NETWORK_PREFIX.match(text):
        # A lora / embedding token: structured data (gen.loras /
        # gen.embeddings), not a tag.
        return "network"
    if text in _EMOTICONS:
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
    return list(_parse_cached(text))


# Reprojection parses the same texts many times over: prompt guessing scores
# every candidate text in a workflow graph, and libraries reuse prompts. The
# parse is pure and `Piece` is frozen, so the cached tuple is safe to share.
@lru_cache(maxsize=4096)
def _parse_cached(text: str) -> tuple[Piece, ...]:
    out: list[Piece] = []
    for raw, in_group in _scan(text):
        s = _clean(raw, in_group)
        if s or raw.strip():
            out.append(Piece(s, classify(s, raw)))
    return tuple(out)
