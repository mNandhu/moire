"""Embeddings (textual inversions) end to end: read from both prompts as
structured data, never as prompt tags; stored as derived rows, filterable in
the feed and counted for the dropdown."""

import sqlalchemy as sa

from src.database import db
from src.database import schema as t
from src.services import reproject
from src.services.gen_metadata import prompt_embeddings
from src.services.prompt_parse import parse_prompt


def test_embedding_syntax_is_one_network_piece():
    pieces = lambda text: [(p.text, p.kind) for p in parse_prompt(text)]  # noqa: E731
    assert pieces("1girl, embedding:lazypos, smile") == [
        ("1girl", "tag"),
        ("embedding:lazypos", "network"),
        ("smile", "tag"),
    ]
    # weighted, mid-run, and only as a word of its own
    assert pieces("(embedding:lazypos:1.2), cat")[0] == ("embedding:lazypos", "network")
    assert pieces("masterpiece embedding:x best")[1] == ("embedding:x", "network")
    assert pieces("my_embedding:x")[0] == ("my_embedding:x", "tag")


def test_prompt_embeddings_names_and_sides():
    got = prompt_embeddings(
        "embedding:lazypos, cat, <embedding:folder/style.pt>",
        "embedding:bad-hands-5.pt, embedding:lazypos, (embedding:negativeXL_D:1.1)",
    )
    assert got == [
        {"name": "lazypos", "negative": False},
        {"name": "style", "negative": False},
        {"name": "bad-hands-5", "negative": True},
        {"name": "lazypos", "negative": True},
        {"name": "negativeXL_D", "negative": True},
    ]


def _comfy(image_id, positive, negative):
    graph = {
        "1": {
            "class_type": "KSampler",
            "inputs": {"seed": 1, "positive": ["2", 0], "negative": ["3", 0]},
        },
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": positive}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": negative}},
    }
    with db.sync_tx() as conn:
        conn.execute(
            sa.delete(t.image_gen_raw).where(t.image_gen_raw.c._id == image_id)
        )
        conn.execute(
            sa.insert(t.image_gen_raw).values(
                _id=image_id,
                library_id="L1",
                workflow_sig=None,
                raw={"source": "comfyui", "prompt": graph},
            )
        )


async def test_embeddings_are_filterable_counted_and_not_tags(client, seed):
    seed("L1:a", tags=())
    seed("L1:b", tags=())
    _comfy("L1:a", "cat, embedding:lazypos", "embedding:badhandv4")
    _comfy("L1:b", "dog", "embedding:badhandv4, embedding:lazyneg")
    reproject.reproject_library("L1")

    doc = (await client.get("/images/L1:a")).json()
    assert doc["gen"]["embeddings"] == [
        {"name": "lazypos", "negative": False},
        {"name": "badhandv4", "negative": True},
    ]
    assert doc["tags"] == ["prompt:cat"]

    ids = lambda r: sorted(it["_id"] for it in r.json())  # noqa: E731
    assert ids(await client.get("/images", params={"embedding": "badhandv4"})) == [
        "L1:a",
        "L1:b",
    ]
    assert ids(await client.get("/images", params={"embedding": "lazypos"})) == ["L1:a"]
    assert (await client.get("/images/embeddings")).json() == [
        {"name": "badhandv4", "count": 2},
        {"name": "lazyneg", "count": 1},
        {"name": "lazypos", "count": 1},
    ]

    _comfy("L1:a", "cat", "")
    reproject.reproject_library("L1")
    counts = (await client.get("/images/embeddings")).json()
    assert counts == [
        {"name": "badhandv4", "count": 1},
        {"name": "lazyneg", "count": 1},
    ]
