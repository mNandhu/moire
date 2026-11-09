"""Tagging a picture that isn't in the library: the raw body goes to the
tagger, its tags come back with the body features picked out, nothing stored."""

from io import BytesIO

from PIL import Image

from moire.services.ai import tagger as ai_tagger


def _png() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (8, 8), (200, 40, 40)).save(buf, format="PNG")
    return buf.getvalue()


async def test_tag_image_returns_tags_with_identity(client, monkeypatch):
    seen = {}

    async def fake_predict(*, image, model_repo, cache_dir, params):
        seen["size"] = image.size
        return {
            "general_tags": [
                ("long_hair", 0.9),
                ("smile", 0.8),
                ("blue_eyes", 0.7),
                ("school_uniform", 0.6),
            ],
            "character_tags": [("fern_(sousou_no_frieren)", 0.95)],
            "rating": {"general": 0.9},
        }

    monkeypatch.setattr(ai_tagger.get_tagger_manager(), "predict_image", fake_predict)
    resp = await client.post(
        "/ai/tag-image", content=_png(), headers={"Content-Type": "image/png"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert seen["size"] == (8, 8)
    assert body["identity"] == ["long_hair", "blue_eyes"]
    assert body["outfit"] == ["school_uniform"]
    assert body["character_tags"][0][0] == "fern_(sousou_no_frieren)"
    assert [t for t, _ in body["general_tags"]][:3] == [
        "long_hair",
        "smile",
        "blue_eyes",
    ]


async def test_tag_image_rejects_empty_and_non_images(client):
    assert (await client.post("/ai/tag-image", content=b"")).status_code == 400
    resp = await client.post("/ai/tag-image", content=b"not an image")
    assert resp.status_code == 400


async def test_tag_image_refuses_huge_dimensions(client):
    buf = BytesIO()
    # Tiny to send, huge to decode: one colour, 9000 px wide.
    Image.new("1", (9000, 10)).save(buf, format="PNG")
    resp = await client.post("/ai/tag-image", content=buf.getvalue())
    assert resp.status_code == 413


async def test_tag_image_refuses_oversized_body(client, monkeypatch):
    from moire.api import ai

    monkeypatch.setattr(ai, "MAX_TAG_IMAGE_BYTES", 100)
    resp = await client.post("/ai/tag-image", content=b"x" * 500)
    assert resp.status_code == 413
