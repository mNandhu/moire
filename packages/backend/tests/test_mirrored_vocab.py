"""Vocabularies kept by hand in both Python and TypeScript must stay equal.

Each test reads the frontend source table and compares it to the backend one,
so adding a colour, kaomoji, facet or merge kind on one side fails here until
the other side follows."""

import json
import re
from pathlib import Path

import pytest

from moire.services import attire, character_look, tag_canon
from moire.services.tag_names import KAOMOJIS, canonical_name

LIB = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib"


def _src(name: str) -> str:
    return (LIB / name).read_text(encoding="utf-8")


def _block(src: str, opener: str) -> str:
    """The text from ``opener`` to the first line that closes it."""
    start = src.index(opener)
    end = re.compile(r"^(\]\)|\]|\}\)|\}|\]\);|\};)\s*;?\s*$", re.M).search(src, start)
    assert end, opener
    return src[start : end.start()]


def _quoted(block: str) -> list[str]:
    return re.findall(r'"([^"]+)"', block)


def test_colour_table_matches():
    block = _block(_src("tagColour.ts"), "const COLOURS")
    ts = {
        name: tuple(int(n) for n in nums)
        for name, *nums in re.findall(
            r"^\s+(\w+): \[(\d+), (\d+), (\d+)\],", block, re.M
        )
    }
    assert {k: v for k, v in ts.items() if k in character_look.COLOURS} == (
        character_look.COLOURS
    )
    assert set(ts) - set(character_look.COLOURS) == set(character_look.NEUTRALS)


def test_multicolour_tags_match():
    block = _block(_src("tagColour.ts"), "const MULTICOLOUR")
    py = set().union(*character_look.MULTICOLOUR.values())
    assert set(_quoted(block)) == py


COLOUR_WORD = json.loads(
    (Path(__file__).parent / "fixtures" / "mirrored" / "colour_word.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", COLOUR_WORD["cases"], ids=lambda c: c["tag"])
def test_colour_word_reads_the_shared_cases(case):
    # tagColour.test.ts reads the same file through colourWord.
    assert character_look.colour_of(case["tag"]) == case["colour"]


def test_kaomojis_match():
    block = _block(_src("tags.ts"), "const KAOMOJIS")
    assert set(_quoted(block)) == set(KAOMOJIS)


def test_facets_match():
    src = _src("tagColour.ts")
    union = re.search(r"export type Facet = ([^;]+);", src)
    assert union
    assert tuple(_quoted(union.group(1))) == attire.FACETS
    for table in ("FACET_LABEL", "FACET_TINT"):
        block = _block(src, f"export const {table}")
        assert tuple(re.findall(r"^\s+(\w+):", block, re.M)) == attire.FACETS


def test_merge_kinds_match():
    kinds = set()
    for line in re.findall(r"Suggestion\(.*", Path(tag_canon.__file__).read_text()):
        kinds |= set(re.findall(r'"([a-z]+)"', line))
    order = re.search(r"KIND_ORDER[^=]*= \[([^\]]*)\]", _src("mergeSuggestions.ts"))
    assert order
    assert set(_quoted(order.group(1))) == kinds
    union = re.search(r"export type MergeKind = ([^;]+);", _src("queries/tags.ts"))
    assert union
    assert set(_quoted(union.group(1))) == kinds


def test_canonical_name_rule_matches():
    # The TS twin is one expression; pin its shape, and the Python behaviour it
    # must reproduce.
    src = _src("tags.ts")
    fn = src[src.index("export function canonicalName") :].split("\n}\n")[0]
    assert 'startsWith("<")' in fn and r"replace(/\s+/g, " in fn and '"_"' in fn
    assert canonical_name("  blue   eyes ") == "blue_eyes"
    assert canonical_name("<lora:a b:0.8>") == "<lora:a b:0.8>"


def test_ai_settings_keys_match():
    from moire.services.ai_settings import DEFAULT_AI_SETTINGS

    block = _block(_src("ai.ts"), "export type AISettings")
    ts = set(re.findall(r"^\s+(\w+): ", block, re.M))
    assert ts == set(DEFAULT_AI_SETTINGS)


def test_ratings_match():
    from moire.services.image_tags import RATINGS

    block = _block(_src("rating.ts"), "export const RATINGS")
    assert ("-", *_quoted(block)) == RATINGS
