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
   inside a group, a trailing ``:weight`` dropped, lowercased. The piece's
   emphasis is kept apart as the groups around it, read into a number by
   :func:`piece_weight` with the rule of the tool that made the image.
3. **Classify** (:func:`classify`): ``tag``, ``prose`` (a sentence fragment:
   kept in the prompt text, never a tag), ``noise`` (leaked settings, lone
   joiners, stray weights) or ``network`` (a ``<lora:...>`` / embedding token,
   recorded as ``gen.loras`` instead of a tag).

The original prompt is always kept verbatim elsewhere; this only decides what
becomes a prompt tag, so it can be improved and simply re-run (reprojection).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Callable
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
# Matched in place at the colon + 1 (leading space allowed), never on a slice
# of the rest, so a check costs the match, not a copy of the prompt.
_WEIGHT_AHEAD = re.compile(r"\s*-?\d*\.?\d+\s*(?:[)\]},]|$)")


# A ``:weight`` written last in a ``(...)`` group, which weighs the whole group.
_GROUP_WEIGHT = re.compile(r":\s*(-?\d*\.?\d+)\s*$")


@dataclass(eq=False)
class _Group:
    """An emphasis group as scanned. Filled in as the scan goes: its weight
    and whether it closed are only known at its closer."""

    kind: str  # "(" | "[" | "{"
    open: int
    weight: float | None = None
    closed: bool = False
    # ``[from:to:0.5]``, ``[x:0.5]`` or ``[a|b]``: A1111 prompt editing or
    # alternation, not emphasis.
    edit: bool = False
    # Where the last emoticon read in it starts (``(a, :3)``: not a weight).
    emoticon: int = -1


# Weight rules by source. ComfyUI (``comfy/sd1_clip.py`` ``token_weights``):
# only a closed ``(...)`` weighs, x1.1, and an explicit ``(...:w)`` *replaces*
# the weight around it; ``[...]``, ``{...}`` and an unclosed ``(`` are text.
# A1111 (``prompt_parser.parse_prompt_attention``): every ``(`` multiplies,
# x1.1 or by its explicit ``:w``, every ``[`` divides by 1.1, closed or not;
# ``{...}`` is text. Outside any group ``smile:1.05`` is text to both.
WEIGHT_SOURCES = ("comfyui", "a1111")


def _comfyui_weight(groups: tuple[_Group, ...]) -> float:
    w = 1.0
    for g in groups:  # outermost first
        if g.kind == "(" and g.closed:
            w = g.weight if g.weight is not None else w * 1.1
    return w


def _a1111_weight(groups: tuple[_Group, ...]) -> float:
    w = 1.0
    for g in groups:
        if g.kind == "(":
            w *= g.weight if g.weight is not None else 1.1
        elif g.kind == "[" and not g.edit:
            w /= 1.1
    return w


@dataclass(frozen=True)
class Piece:
    text: str
    kind: str  # "tag" | "prose" | "noise" | "network"
    # The emphasis groups around it, outermost first. Not part of equality:
    # two pieces reading the same text are the same piece.
    groups: tuple[_Group, ...] = field(default=(), compare=False, repr=False)

    def weight(self, source: str | None) -> float:
        """The piece's prompt weight as ``source`` (``gen.source``) reads it;
        anything not ComfyUI reads as A1111. Rounded to 4 places; one that
        shows as 1 at the two places it is shown at is 1."""
        rule = _comfyui_weight if source == "comfyui" else _a1111_weight
        w = rule(self.groups)
        if not math.isfinite(w) or round(w, 2) == 1:
            return 1.0
        return round(w, 4)


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
            or (text[j] == ":" and _WEIGHT_AHEAD.match(text, j + 1))
        ):
            return length
    return 0


def _atom_at(text: str, i: int, has_text: bool) -> tuple[str, int] | None:
    """A token that passes through whole: ``(raw, end)`` of the emoticon tag
    (only at a piece start), ``embedding:name`` or ``<lora:...>`` token at
    ``i``, else ``None``."""
    if not has_text:
        length = _emoticon_at(text, i)
        if length:
            return text[i : i + length], i + length
    ch = text[i]
    if ch in "eE" and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
        # embedding:name: its own piece even mid-run ("x embedding:y z").
        m = EMBEDDING_TOKEN.match(text, i)
        if m:
            return m.group(0), m.end()
    if ch == "<":
        # <lora:name:0.8> / <embedding:x>: one opaque piece, but only when it
        # really is one. Any other "<" (``<3``, a kaomoji) is text.
        m = _NETWORK_TOKEN.match(text, i)
        if m:
            return m.group(0), m.end()
    return None


def _skip_at(text: str, i: int) -> int:
    """Length of a separator that is dropped, not kept: a ``BREAK`` / ``AND``
    keyword or an escaped comma (a tag never holds a comma), else 0."""
    if text.startswith("\\,", i):
        return 2
    return _keyword_at(text, i)


def _is_edit_colon(text: str, i: int) -> bool:
    """Whether the ``:`` at ``i``, inside ``[...]``, is A1111 prompt editing
    (``[from:to:0.5]``) rather than a weight: the two sides are separate
    pieces. Inside ``(...)`` a colon is text (``(artist:name)``) or a weight."""
    return not _WEIGHT_AHEAD.match(text, i + 1)


@dataclass(frozen=True)
class RawPiece:
    text: str
    # The enclosing groups, outermost first (empty outside any group).
    groups: tuple[_Group, ...]

    @property
    def stack(self) -> tuple[str, ...]:
        """The enclosing bracket kinds, outermost first."""
        return tuple(g.kind for g in self.groups)

    @property
    def in_group(self) -> bool:
        """Only inside a group is ``:n`` a weight."""
        return bool(self.groups)


def _close(text: str, g: _Group, i: int) -> None:
    """Mark ``g`` closed by the closer at ``i`` and read its weight: only a
    ``(...)`` carries one, written last (``(a, b:1.2)``). A ``:n`` closing a
    ``[...]`` is A1111 prompt editing. A last member that is an emoticon
    (``(a, :3)``) is a member, not a weight."""
    g.closed = True
    m = _GROUP_WEIGHT.search(text, g.open + 1, i)
    if not m or m.start() == g.open + 1:
        return
    if g.kind == "[":
        g.edit = True
    elif g.kind == "(" and g.emoticon != m.start():
        g.weight = float(m.group(1))


def _scan(text: str) -> list[RawPiece]:
    """Raw pieces of ``text``, cut at separators and emphasis-group edges,
    each with the brackets it sat inside."""
    pieces: list[RawPiece] = []
    buf: list[str] = []
    # Whether `buf` holds any non-space text (kept as a flag, not re-derived,
    # so the scan stays linear in the prompt length).
    has_text = False
    # Open groups, innermost last.
    stack: list[_Group] = []

    def flush() -> None:
        nonlocal has_text
        if buf:
            pieces.append(RawPiece("".join(buf), tuple(stack)))
            buf.clear()
        has_text = False

    def emit(raw: str) -> None:
        flush()
        pieces.append(RawPiece(raw, tuple(stack)))

    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if not has_text and ch.isspace():
            i += 1
            continue
        atom = _atom_at(text, i, has_text)
        if atom:
            if stack and not has_text:
                stack[-1].emoticon = i
            emit(atom[0])
            i = atom[1]
            continue
        skip = _skip_at(text, i)
        if skip:
            flush()
            i += skip
            continue
        if ch == "\\" and i + 1 < n:
            # An escape is literal text (``\(``).
            buf.append(text[i + 1])
            has_text = True
            i += 2
            continue
        if ch in _SEPARATORS:
            if ch == "|" and stack and stack[-1].kind == "[":
                # ``[a|b]``: A1111 alternation, not emphasis.
                stack[-1].edit = True
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
            stack.append(_Group(ch, i))
            i += 1
            continue
        if ch in _CLOSE:
            # Closes a group, or is a stray: a boundary either way.
            flush()
            if stack:
                _close(text, stack.pop(), i)
            i += 1
            continue
        if ch == ":" and has_text and stack and stack[-1].kind == "[":
            # A weight colon is left for _clean to strip.
            if _is_edit_colon(text, i):
                stack[-1].edit = True
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
    for raw in _scan(text):
        s = _clean(raw.text, raw.in_group)
        if s or raw.text.strip():
            out.append(Piece(s, classify(s, raw.text), raw.groups))
    return tuple(out)


def _top_level_pieces(text: str) -> list[tuple[str, str]]:
    """``text`` cut at commas and newlines outside brackets, each piece with the
    separator after it (``""`` for the last)."""
    out: list[tuple[str, str]] = []
    depth, start = 0, 0
    for i, ch in enumerate(text):
        if ch in "([" and (i == 0 or text[i - 1] != "\\"):
            depth += 1
        elif ch in ")]" and (i == 0 or text[i - 1] != "\\"):
            depth = max(0, depth - 1)
        elif ch in ",\n" and depth == 0:
            out.append((text[start:i], ch))
            start = i + 1
    out.append((text[start:], ""))
    return out


def without_terms(text: str, drop: set[str], canon: Callable[[str], str]) -> str:
    """``text`` with every piece whose tags all canonicalize (``canon``) into
    ``drop`` taken out, separators and the rest kept as written. A weighted
    group goes only when everything in it goes."""
    kept: list[str] = []
    dropped = False
    for piece, sep in _top_level_pieces(text):
        tags = [p.text for p in parse_prompt(piece) if p.kind == "tag"]
        if tags and all(canon(t) in drop for t in tags):
            dropped = True
        else:
            kept.append(piece + sep)
    out = "".join(kept)
    # A dropped first or last piece leaves a separator dangling at that end.
    return re.sub(r"^[\s,]+|[\s,]+$", "", out) if dropped else out
