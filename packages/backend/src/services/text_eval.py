"""Computing the text a ComfyUI string node outputs, from the graph alone.

A display node (ShowText) records the text it was showing *when the prompt was
queued*: the previous run's output, not this one's. A runtime-built prompt
read off a display node is therefore often one run behind. When every node
feeding it is a plain string operation (literals, find/replace, regex
extraction, joins), the exact text this run produced can be computed from
the graph's own inputs instead.

:func:`evaluate` does that for a known set of nodes and gives up (``None``)
on anything else: a captioner, an LLM, a wildcard, an unknown custom node.
Exact or nothing; a guess here would be worse than the stale display.
Pure.
"""

from __future__ import annotations

import re
from typing import Any, Callable

# Literal string nodes: (class_type predicate, widget holding the text).
_LITERAL_KEYS = ("text", "string", "value")
# Dynamic-prompt syntax: `{a|b}` choices and `__wildcard__` files, resolved at
# run time with the seed, so the widget text isn't what ran.
_DYNAMIC = re.compile(r"\{[^{}]*\|[^{}]*\}|__[\w/\-.]+__")
_FIND_REPLACE_SLOTS = ("", *(f"_{i}" for i in range(2, 9)))


def _unescape(s: str) -> str:
    # The find/replace widgets take `\n` typed as two characters.
    return s.replace("\\n", "\n").replace("\\t", "\t")


def _is_literal(ct: str) -> bool:
    lc = ct.lower()
    return (
        lc.startswith("primitive")
        or lc in ("text multiline", "string literal", "text box", "text")
        or lc.startswith("string literal")
    )


def evaluate(prompt_json: dict[str, Any], ref: Any) -> str | None:
    """The text output ``ref`` (``[node_id, slot]``) carries, or ``None``."""
    return _eval(prompt_json, ref, set())


def _eval(prompt_json: dict[str, Any], ref: Any, seen: set[str]) -> str | None:
    if not (isinstance(ref, list) and len(ref) == 2):
        return None
    key, slot = str(ref[0]), ref[1]
    node = prompt_json.get(key)
    if key in seen or not isinstance(node, dict) or not isinstance(slot, int):
        return None
    inp = node.get("inputs")
    if not isinstance(inp, dict):
        return None
    ct = str(node.get("class_type") or "")
    seen = seen | {key}

    def value(v: Any) -> str | None:
        if isinstance(v, str):
            return v
        if isinstance(v, list):
            return _eval(prompt_json, v, seen)
        return None

    handler = _HANDLERS.get(ct)
    if handler is not None:
        return handler(inp, slot, value)
    if _is_literal(ct) and slot == 0:
        text = next(
            (inp[k] for k in _LITERAL_KEYS if isinstance(inp.get(k), str)), None
        )
        if text is None:
            return None
        if inp.get("dynamic_prompts") is True and _DYNAMIC.search(text):
            return None
        return text
    return None


Value = Callable[[Any], "str | None"]


def _find_replace(inp: dict, slot: int, value: Value) -> str | None:
    """WAS "Text Find and Replace": up to eight find/replace pairs in order."""
    text = value(inp.get("text"))
    if slot != 0 or text is None:
        return None
    for suffix in _FIND_REPLACE_SLOTS:
        find = inp.get(f"find{suffix}")
        if isinstance(find, str) and find:
            repl = inp.get(f"replace{suffix}")
            text = text.replace(
                _unescape(find), _unescape(repl if isinstance(repl, str) else "")
            )
    return text


def _regex_chopper(inp: dict, slot: int, value: Value) -> str | None:
    """ "Regex Text Chopper": outputs Part 1 to 4 (the first four matches) and
    All parts. How All parts joins several matches isn't known, so only a
    single match is computed for it."""
    text, pattern = value(inp.get("text")), inp.get("regex")
    if text is None or not isinstance(pattern, str):
        return None
    try:
        matches = re.findall(pattern, text)
    except re.error:
        return None
    if any(not isinstance(m, str) for m in matches):
        return None  # several groups: no single string per match
    if slot == 4:
        return matches[0] if len(matches) == 1 else ("" if not matches else None)
    return matches[slot] if 0 <= slot < len(matches) else ("" if slot < 4 else None)


def _text_concat(inp: dict, slot: int, value: Value) -> str | None:
    """TextConcat: text1..textN joined by ``delimiter``, empty parts skipped."""
    delim = inp.get("delimiter")
    if slot != 0 or not isinstance(delim, str):
        return None
    parts: list[str] = []
    for k in sorted(
        (k for k in inp if re.fullmatch(r"text\d+", k)), key=lambda k: int(k[4:])
    ):
        v = value(inp[k])
        if v is None:
            return None
        if v:
            parts.append(v)
    return delim.join(parts)


def _string_concatenate(inp: dict, slot: int, value: Value) -> str | None:
    """Core StringConcatenate: ``string_a`` + ``delimiter`` + ``string_b``."""
    a, b, delim = (
        value(inp.get("string_a")),
        value(inp.get("string_b")),
        inp.get("delimiter"),
    )
    if slot != 0 or a is None or b is None or not isinstance(delim, str):
        return None
    return a + delim + b


def _show_text(inp: dict, slot: int, value: Value) -> str | None:
    """A display node passes its input through."""
    return value(inp.get("text")) if slot == 0 else None


_HANDLERS: dict[str, Callable[[dict, int, Value], str | None]] = {
    "Text Find and Replace": _find_replace,
    "Regex Text Chopper -noEmbryo": _regex_chopper,
    "TextConcat": _text_concat,
    "StringConcatenate": _string_concatenate,
    "ShowText|pysssss": _show_text,
}
