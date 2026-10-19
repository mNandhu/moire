"""AI job worker: inference must run off the event loop, and the next image's
read + decode must overlap the current inference."""

import asyncio
import time

from PIL import Image

from src.services import ai_jobs
from src.services.ai_jobs import AIJobManager
from src.services.ai_tagger import TaggerManager

_RESULT = {"caption": "", "rating": {}, "general_tags": [], "character_tags": []}

_PREDICT_KW = dict(
    model_repo="r",
    cache_dir="/c",
    general_thresh=0.35,
    character_thresh=0.85,
    general_mcut=False,
    character_mcut=False,
    max_general=80,
    max_character=40,
)


async def test_predict_image_does_not_block_event_loop(monkeypatch):
    mgr = TaggerManager()

    async def fake_ensure_loaded(*, model_repo: str, cache_dir: str) -> None:
        return None

    def slow_predict(**_kw):
        time.sleep(0.3)  # a blocking ONNX run
        return _RESULT

    monkeypatch.setattr(mgr, "ensure_loaded", fake_ensure_loaded)
    monkeypatch.setattr(mgr._tagger, "predict", slow_predict)

    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    tick_task = asyncio.create_task(ticker())
    try:
        out = await mgr.predict_image(image=Image.new("RGBA", (4, 4)), **_PREDICT_KW)
    finally:
        tick_task.cancel()
    assert out is _RESULT
    # A blocked loop would tick ~0 times during the 0.3s run.
    assert ticks >= 10


def _job_manager(
    monkeypatch, events: list[str], *, fail_load: frozenset[str] = frozenset()
):
    mgr = AIJobManager()

    async def fake_load(image_id: str):
        events.append(f"load-start:{image_id}")
        await asyncio.sleep(0.01)
        if image_id in fail_load:
            raise RuntimeError("unreadable")
        events.append(f"load-end:{image_id}")
        return Image.new("RGBA", (4, 4))

    async def fake_tag_one(*, image_id: str, image, settings):
        events.append(f"tag-start:{image_id}")
        await asyncio.sleep(0.05)
        events.append(f"tag-end:{image_id}")

    async def fake_settings():
        return {}

    monkeypatch.setattr(mgr, "_load_image", fake_load)
    monkeypatch.setattr(mgr, "_tag_one", fake_tag_one)
    monkeypatch.setattr(ai_jobs, "get_ai_settings", fake_settings)
    return mgr


async def _run(mgr: AIJobManager, ids: list[str]):
    worker = asyncio.create_task(mgr._worker_loop())
    job = await mgr.enqueue(ids=ids)
    try:
        for _ in range(500):
            if job.status in ("done", "error", "cancelled"):
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()
    return job


async def test_worker_prefetches_next_image_during_inference(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    job = await _run(mgr, ["a", "b", "c"])

    assert job.status == "done" and job.done == 3
    # b's load starts before a's inference finishes.
    assert events.index("load-start:b") < events.index("tag-end:a")
    assert events.index("load-start:c") < events.index("tag-end:b")


async def test_worker_counts_failed_load_and_continues(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events, fail_load={"b"})
    job = await _run(mgr, ["a", "b", "c"])

    assert job.status == "error"
    assert (job.done, job.failed) == (2, 1)
    assert job.errors[0]["image_id"] == "b"
    assert "tag-start:b" not in events


async def test_cancel_drops_the_prefetch(monkeypatch):
    events: list[str] = []
    mgr = _job_manager(monkeypatch, events)
    worker = asyncio.create_task(mgr._worker_loop())
    job = await mgr.enqueue(ids=["a", "b", "c"])
    try:
        while "tag-start:a" not in events:
            await asyncio.sleep(0.005)
        await mgr.cancel(job.id)
        for _ in range(100):
            if job.status == "cancelled":
                break
            await asyncio.sleep(0.01)
    finally:
        worker.cancel()

    assert job.status == "cancelled" and job.done == 1
    assert "tag-start:b" not in events
    assert not mgr._in_flight
