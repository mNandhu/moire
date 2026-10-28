"""The shared prompt-terms fixture: parse_prompt must read every case the way
the fixture says, and the frontend's promptOutline is checked against the
same file (see its `about` field for what is compared)."""

import json
from pathlib import Path

import pytest

from moire.services.prompt_parse import parse_prompt
from moire.services.tag_names import canonical_name

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "mirrored" / "prompt_terms.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: repr(c["text"]))
def test_parse_prompt_reads_the_shared_cases(case):
    def read(source):
        return [
            [canonical_name(p.text), p.kind, p.weight(source)]
            for p in parse_prompt(case["text"], source)
        ]

    assert read("comfyui") == [t[:3] for t in case["terms"]]
    a1111 = case.get("a1111_terms") or [[*t[:2], t[3]] for t in case["terms"]]
    assert read("a1111") == a1111


AUTO_NAME = json.loads(
    (
        Path(__file__).parent / "fixtures" / "mirrored" / "auto_name_terms.json"
    ).read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", AUTO_NAME["cases"], ids=lambda c: repr(c["text"]))
def test_auto_name_terms_read_the_shared_cases(case):
    from moire.services.generation_compose import prompt_terms

    assert prompt_terms(case["text"], limit=case["limit"]) == case["terms"]
