"""Library routes join scan and watch threads off the event loop."""

import asyncio
import time


from moire.services import library_ops
from moire.services import library_watch


async def test_delete_does_not_block_the_loop_on_thread_joins(client, monkeypatch):
    def slow_join(*_a, **_k):
        time.sleep(0.2)

    monkeypatch.setattr(library_ops, "cancel_scan", slow_join)
    monkeypatch.setattr(library_watch, "stop_watch", slow_join)

    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    tick_task = asyncio.create_task(ticker())
    try:
        await client.delete("/libraries/nope")
    finally:
        tick_task.cancel()
    # A blocked loop would tick ~0 times during the 0.4s of joins.
    assert ticks >= 15
