"""Suggested merge rules: prompt tags that aren't Danbooru tags, read as the
Danbooru tag (or tags) they mean.

Prompts are written by hand (or by an LLM), so they carry names Danbooru
doesn't use: ``black_heart_pasties``, ``long_white_hair``, ``red_roses``.
Each is checked against Danbooru's list (:mod:`danbooru_tags`) in this order,
the first stage that finds something winning:

1. **alias**: Danbooru's own alias (``blowjob`` is ``fellatio``).
2. **respell**: the same words spelled Danbooru's way: singular
   (``red_roses`` to ``red_rose``), joined (``body_suit``, ``one_piece`` to
   ``one-piece``), a colour synonym (``silver_hair`` to ``grey_hair``).
3. **colour**: colour words plus the thing, as one tag
   (``dark_blue_suit`` to ``blue_suit``).
4. **split**: each describing word joins the thing's last word as a tag of
   its own (``long_white_hair`` to ``long_hair`` + ``white_hair``,
   ``red_turtleneck_sweater`` to ``turtleneck_sweater`` + ``red_sweater``).
5. **strip**: the colour dropped, when nothing keeps it
   (``black_heart_pasties`` to ``heart_pasties``).

A term that is already a Danbooru tag, of any category, is left alone, and
so is one no stage reads. Targets past the alias stage are general tags with
:data:`MIN_POSTS` posts, so a rare or oddly categorised tag is never offered.
These are suggestions only: the user accepts them as merge rules
(:mod:`tag_rename`). Pure: the list comes in as a :class:`TagList`.
"""

from __future__ import annotations

from dataclasses import dataclass

from .danbooru_tags import ARTIST, GENERAL, TagList

# A target this rare is likely a mistag or a niche spelling.
MIN_POSTS = 100

COLOURS = frozenset(
    "red blue green yellow orange purple pink black white grey brown aqua "
    "silver gold blonde beige".split()
)
# Words that shade a colour (``dark_blue``) and travel with it.
TONES = frozenset("light dark pale bright deep neon pastel".split())
# Spellings Danbooru doesn't use for a colour. ``silver_hair`` and
# ``gray_hair`` are both ``grey_hair`` there, but only the second is an alias.
COLOUR_SYNONYMS = {"silver": "grey", "gray": "grey", "golden": "gold"}
# Heads a colour describes a person by, not a thing: ``black_male`` is not
# ``male_focus``.
SKIP_HEADS = frozenset("male female man woman boy girl skin people person body".split())


@dataclass(frozen=True)
class Suggestion:
    """``name`` read as ``to`` (one tag: a merge; more: a split)."""

    name: str
    to: tuple[str, ...]
    kind: str


def _singular(word: str) -> list[str]:
    if len(word) <= 3 or not word.endswith("s") or word.endswith("ss"):
        return []
    out = [word[:-1]]
    if word.endswith("ies"):
        out.insert(0, word[:-3] + "y")
    elif word.endswith("es"):
        out.append(word[:-2])
    return out


def _respellings(words: list[str]) -> list[str]:
    """Other spellings of the same words, closest first."""
    out: list[str] = []
    swapped = [COLOUR_SYNONYMS.get(w, w) for w in words]
    if swapped != words:
        out.append("_".join(swapped))
    for base in (words, swapped) if swapped != words else (words,):
        for s in _singular(base[-1]):
            out.append("_".join([*base[:-1], s]))
    for i in range(len(words) - 1):
        head, tail = words[:i], words[i + 2 :]
        for joiner in ("", "-"):
            out.append("_".join([*head, words[i] + joiner + words[i + 1], *tail]))
    return out


class Resolver:
    """Stages 1 to 5 over one tag list."""

    def __init__(self, tags: TagList) -> None:
        self.tags = tags

    def _general(self, name: str, *, alias: bool = True) -> str | None:
        """``name`` (or, with ``alias``, the tag it is an alias of) if it is a
        common general tag. A respelling must be a tag itself: ``groups`` read
        as ``group`` is Danbooru's alias for ``everyone``, a different word."""
        tag = self.tags.resolve(name) if alias else name
        info = self.tags.tags.get(tag)
        if info is None or info[0] != GENERAL or info[1] < MIN_POSTS:
            return None
        return tag

    def _thing(self, words: list[str]) -> str | None:
        """The general tag these words name, as written or respelled."""
        name = "_".join(words)
        if (tag := self._general(name)) is not None:
            return tag
        for alt in _respellings(words):
            if (tag := self._general(alt, alias=False)) is not None:
                return tag
        return None

    def suggest(self, name: str) -> Suggestion | None:
        if not name or name.startswith("<") or ":" in name:
            return None
        if name in self.tags.tags:
            return None
        if name in self.tags.aliases:
            tag = self.tags.aliases[name]
            # Artists collect odd aliases (``2d``); a prompt word isn't one.
            if self.tags.tags[tag][0] == ARTIST:
                return None
            return Suggestion(name, (tag,), "alias")
        words = name.split("_")
        for alt in _respellings(words):
            if (tag := self._general(alt, alias=False)) is not None:
                return Suggestion(name, (tag,), "respell")
        if len(words) < 2:
            return None
        return (
            self._colour(name, words)
            or self._split(name, words)
            or self._strip(name, words)
        )

    def _heads(self, words: list[str]):
        """``(describing words, head tag)``, longest head first."""
        for i in range(1, len(words)):
            head = self._thing(words[i:])
            if head is not None:
                yield words[:i], head

    def _colour(self, name: str, words: list[str]) -> Suggestion | None:
        for prefix, head in self._heads(words):
            if not _all_colour(prefix):
                continue
            colours = [w for w in prefix if w not in TONES]
            for c in ("_".join(prefix), COLOUR_SYNONYMS.get(colours[-1], colours[-1])):
                tag = self._general(f"{c}_{head}")
                if tag is not None and tag != name:
                    return Suggestion(name, (tag,), "colour")
        return None

    def _split(self, name: str, words: list[str]) -> Suggestion | None:
        for prefix, head in self._heads(words):
            last = head.split("_")[-1]
            parts: list[str] = []
            for group in _groups(prefix):
                # A tone on its own (``dark_red_eyes``) shades, it isn't a tag.
                if all(w in TONES for w in group):
                    break
                tag = self._thing([*group, last])
                if tag is None or tag == name:
                    break
                parts.append(tag)
            else:
                # A part that is a kind of the head (``fishnet_thighhighs``)
                # already says it.
                if not any(p.endswith("_" + head) for p in parts):
                    parts.append(head)
                to = tuple(dict.fromkeys(parts))
                return Suggestion(name, to, "split" if len(to) > 1 else "respell")
        return None

    def _strip(self, name: str, words: list[str]) -> Suggestion | None:
        for prefix, head in self._heads(words):
            rest = "_".join(words[len(prefix) :])
            if not _all_colour(prefix) or rest in SKIP_HEADS or head in SKIP_HEADS:
                continue
            # A qualifier the alias adds (``plugsuit_(evangelion)``) names
            # something narrower than the words did.
            if "(" in head and "(" not in rest:
                continue
            return Suggestion(name, (head,), "strip")
        return None


def _all_colour(words: list[str]) -> bool:
    return any(w in COLOURS or w in COLOUR_SYNONYMS for w in words) and all(
        w in COLOURS or w in COLOUR_SYNONYMS or w in TONES for w in words
    )


def _groups(words: list[str]) -> list[list[str]]:
    """Describing words, a tone kept with the colour it shades."""
    out: list[list[str]] = []
    pending: list[str] = []
    for w in words:
        if w in TONES:
            pending.append(w)
            continue
        out.append([*pending, w])
        pending = []
    if pending:
        out.append(pending)
    return out


def suggest_all(names, tags: TagList) -> list[Suggestion]:
    """A suggestion for each name some stage reads, in input order."""
    if not tags.tags:
        return []
    r = Resolver(tags)
    return [s for n in names if (s := r.suggest(n)) is not None]
