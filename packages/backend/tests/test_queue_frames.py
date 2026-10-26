from types import SimpleNamespace

from moire.services.generation_batches import _frames


def req(state, images):
    return SimpleNamespace(state=state, images=images)


def test_a_done_request_pairs_each_image_with_its_own_thumbnail():
    outs = [{"thumb_url": "/a"}, {"thumb_url": None}]
    assert _frames(req("done", 3), outs) == [
        {"state": "done", "thumb": "/a"},
        {"state": "done", "thumb": None},
        {"state": "done", "thumb": None},
    ]


def test_open_and_failed_requests_count_their_images():
    assert [f["state"] for f in _frames(req("failed", 2), [])] == ["failed"] * 2
    assert [f["state"] for f in _frames(req("running", 2), [])] == ["making"] * 2
    assert [f["state"] for f in _frames(req("queued", None), [])] == ["waiting"]


def test_every_request_state_has_one_place_in_the_vocabulary():
    from moire.services.generation_states import (
        FAILED,
        IN_COMFY,
        REPLACED,
        RETRYABLE,
        UNFINISHED,
    )

    assert set(IN_COMFY) < set(UNFINISHED)
    assert set(FAILED) < set(RETRYABLE)
    # Unfinished, ended and replaced never overlap.
    assert not set(UNFINISHED) & set(RETRYABLE)
    assert REPLACED not in (*UNFINISHED, *RETRYABLE)
    # Each state draws a frame (replaced ones are filtered before this).
    for state in (*UNFINISHED, *RETRYABLE):
        assert _frames(req(state, 1), [])
