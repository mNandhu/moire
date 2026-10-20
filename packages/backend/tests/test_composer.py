"""The layered composer: prompt presets, ordered parts reaching ComfyUI, the
auto name from the Prompt, and requeue replaying what was sent."""

from __future__ import annotations

from tests.test_generate_integration import comfy, make_ready  # noqa: F401


async def test_presets_are_seeded_once_and_editable(client):
    first = (await client.get("/generate/presets")).json()
    assert {p["kind"] for p in first} == {"positive", "negative"}
    for p in first:
        assert (await client.delete(f"/generate/presets/{p['_id']}")).status_code == 200
    # Deleted defaults don't come back.
    assert (await client.get("/generate/presets")).json() == []

    made = (
        await client.post(
            "/generate/presets",
            json={"name": "Mine", "kind": "positive", "text": " best quality "},
        )
    ).json()
    assert made["text"] == "best quality"
    r = await client.put(
        f"/generate/presets/{made['_id']}", json={"text": "masterpiece"}
    )
    assert r.json()["text"] == "masterpiece"
    bad = await client.post("/generate/presets", json={"name": "", "kind": "positive"})
    assert bad.status_code == 400
    assert (await client.put("/generate/presets/nope", json={})).status_code == 404


def _texts(graph):
    return [
        n["inputs"]["text"]
        for n in graph.values()
        if n["class_type"] == "CLIPTextEncode"
    ]


async def test_layers_compose_in_order_and_requeue(client, comfy, seed):  # noqa: F811
    await make_ready(client, comfy, seed)
    body = {
        "positive": [
            {"kind": "text", "role": "prefix", "text": "masterpiece, best quality,"},
            {"kind": "character"},
            {"kind": "embedding", "name": "pos/aesthetic"},
            {
                "kind": "text",
                "role": "prompt",
                "text": "(smile:1.2), sitting on a swing",
            },
        ],
        "negative": [
            {"kind": "text", "role": "prefix", "text": "lowres"},
            {"kind": "text", "role": "prompt", "text": "blurry"},
        ],
        "composer": {"v": 2, "prompt": "(smile:1.2), sitting on a swing"},
        "count": 1,
    }
    res = await client.post("/generate/batches", json=body)
    assert res.status_code == 200, res.text
    batch = res.json()
    # No character picked: its layer adds nothing; the name comes from the Prompt.
    assert batch["name"] == "Built-in, smile, sitting on a swing"
    want = [
        "masterpiece, best quality, embedding:pos/aesthetic, (smile:1.2), sitting on a swing",
        "lowres, blurry",
    ]
    assert sorted(_texts(comfy.prompts[comfy.order[-1]])) == sorted(want)
    assert batch["inputs"]["composer"] == body["composer"]

    again = await client.post(f"/generate/batches/{batch['_id']}/requeue")
    assert again.status_code == 200, again.text
    assert sorted(_texts(comfy.prompts[comfy.order[-1]])) == sorted(want)
