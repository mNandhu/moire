"""Best-effort prompt parsing: tricky, malformed and mixed prompts.

Patterns recreated from real prompts with neutral wording."""

import pytest

from src.services.prompt_parse import classify, is_prose, parse_prompt


def tags(text):
    return [p.text for p in parse_prompt(text) if p.kind == "tag"]


@pytest.mark.parametrize(
    "prompt, expected",
    [
        # plain tags
        ("1girl, solo, blue eyes", ["1girl", "solo", "blue eyes"]),
        # emphasis and weights are not part of the tag
        (
            "((masterpiece)), (best quality:1.2), [blurry]",
            ["masterpiece", "best quality", "blurry"],
        ),
        # weighted groups with no comma between them
        (
            "(smiling:1.05)(red scarf:1.25) and (green eyes",
            ["smiling", "red scarf", "green eyes"],
        ),
        # a group opened in one piece and closed in another
        ("(tag one, tag two:1.1), tag three", ["tag one", "tag two", "tag three"]),
        # stray closer, unclosed opener
        ("cat), (dog, bird", ["cat", "dog", "bird"]),
        # Danbooru qualifier stays in the tag, escaped or not
        (r"hu tao \(genshin impact\), smile", ["hu tao (genshin impact)", "smile"]),
        ("hu_tao_(genshin_impact), smile", ["hu_tao_(genshin_impact)", "smile"]),
        # after a space, an unescaped group is emphasis: two tags
        ("hu tao (genshin impact), smile", ["hu tao", "genshin impact", "smile"]),
        # qualifier inside a weighted group
        ("(hu_tao_(genshin_impact):1.2)", ["hu_tao_(genshin_impact)"]),
        # lora tokens pass whole
        ("<lora:my style:0.8>, cat", ["<lora:my style:0.8>", "cat"]),
        # newlines, BREAK and AND separate
        ("cat\ndog BREAK bird AND fish", ["cat", "dog", "bird", "fish"]),
        # prompt editing and alternation
        ("[cat:dog:0.5], {red|blue}", ["cat", "dog", "red", "blue"]),
        # bare weights and joiners are dropped
        ("cat, :1.2), and, 1.5", ["cat"]),
        # leaked settings and a stray negative marker
        (
            "cat, vae: some vae, Steps: 20, (dog:0.7)negative prompt: worst quality",
            ["cat", "dog", "worst quality"],
        ),
        # edge punctuation from sentences
        ("paired with shorts.", ["paired with shorts"]),
    ],
)
def test_parse_prompt_tags(prompt, expected):
    assert tags(prompt) == expected


def test_prose_pieces_are_classified_not_tags():
    prompt = (
        "1girl, a girl stands barefoot at a small counter in morning light, "
        "the girl is tired. she has long hair, hair over one eye"
    )
    kinds = {p.text: p.kind for p in parse_prompt(prompt)}
    assert kinds["1girl"] == "tag"
    assert kinds["hair over one eye"] == "tag"
    assert (
        kinds["a girl stands barefoot at a small counter in morning light"] == "prose"
    )
    assert kinds["the girl is tired. she has long hair"] == "prose"


@pytest.mark.parametrize(
    "text",
    [
        "looking to the side",
        "year of the tiger",
        "st. gloriana's school uniform",
        "artoria pendragon (alter swimsuit rider) (second ascension) (fate)",
        "zero two (darling in the franxx)",
        "oversized baby blue cropped hoodie",
        "denpa onna to seishun otoko",
    ],
)
def test_real_tags_are_not_prose(text):
    assert not is_prose(text)


def test_never_raises_on_garbage():
    for junk in ["", "(((", ")))", "\\", "<", ":::", "((a:)b:c)", ",,,", "\\(\\"]:
        parse_prompt(junk)
    assert classify("") == "noise"


@pytest.mark.parametrize(
    "prompt, expected",
    [
        # emoticon tags survive whole
        ("smile, :d, ;p, @_@, ^_^, >:)", ["smile", ":d", ";p", "@_@", "^_^", ">:)"]),
        # a colon inside (...) is text, not prompt editing
        ("(artist:somename:1.1), (artist:other)", ["artist:somename", "artist:other"]),
        # long qualifiers, odd spacing inside them
        (
            "chara_name_( some long series title here ), x",
            ["chara_name_(some long series title here)", "x"],
        ),
        # run-on joiner at the start of a piece
        ("and black thigh-highs.", ["black thigh-highs"]),
        # size settings are noise
        ("cat, width: 832, height: 1216", ["cat"]),
    ],
)
def test_parse_prompt_tags_more(prompt, expected):
    assert tags(prompt) == expected


def test_closing_period_marks_a_sentence():
    assert [p.kind for p in parse_prompt("paired with tight low-rise shorts.")] == [
        "prose"
    ]


@pytest.mark.parametrize(
    "prompt, expected",
    [
        # an unclosed or non-network "<" is text, it doesn't swallow the rest
        ("cat, <lora:foo:0.8, dog, bird", ["cat", "<lora:foo:0.8", "dog", "bird"]),
        ("a <3 b, cat", ["a <3 b", "cat"]),
        ("(>_<:1.2), smile, <lora:x:1>", [">_<", "smile", "<lora:x:1>"]),
        # emoticon inside a weighted group
        ("(:d:1.2), (:3:1.1)", [":d", ":3"]),
        # keywords inside a lora name don't split it
        ("<lora:style AND light:0.8>, cat", ["<lora:style and light:0.8>", "cat"]),
        # an escaped comma still separates
        (r"cat\, dog", ["cat", "dog"]),
        # outside a group ":n" is text, not a weight
        ("16:9, 12:00, (tag:1.2), smile:1.05", ["16:9", "12:00", "tag", "smile"]),
        # emphasis after a name, missing commas
        (
            "1girl, solo (smile), girl (blue eyes) (long hair)",
            ["1girl", "solo", "smile", "girl", "blue eyes", "long hair"],
        ),
    ],
)
def test_review_cases(prompt, expected):
    assert tags(prompt) == expected


def test_scan_is_linear():
    import time

    long_piece = "word " * 3000
    started = time.perf_counter()
    parse_prompt(long_piece)
    assert time.perf_counter() - started < 0.05
