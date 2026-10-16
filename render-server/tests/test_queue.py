"""The render queue's order and the blob store's budget (no Blender needed)."""

import asyncio
import os

from fury_render.api import BlobStore, RenderQueue


def test_waiting_views_go_ahead_of_pre_renders():
    async def scenario():
        queue = RenderQueue()
        order = []

        async def job(name, kind, hold=0.0):
            async with queue.turn(kind):
                order.append(name)
                await asyncio.sleep(hold)

        # A pre-render is in progress; it is never interrupted.
        first = asyncio.create_task(job("orbit-1", "orbit", 0.05))
        await asyncio.sleep(0.01)
        waiting = [
            asyncio.create_task(job("orbit-2", "orbit")),
            asyncio.create_task(job("view", "view")),
            asyncio.create_task(job("preview", "preview")),
        ]
        await asyncio.gather(first, *waiting)
        return order

    assert asyncio.run(scenario()) == ["orbit-1", "preview", "view", "orbit-2"]


def test_a_cancelled_wait_does_not_block_the_queue():
    async def scenario():
        queue = RenderQueue()
        await queue.acquire("view")
        gone = asyncio.create_task(queue.acquire("preview"))
        await asyncio.sleep(0)
        gone.cancel()
        later = asyncio.create_task(queue.acquire("view"))
        await asyncio.sleep(0)
        queue.release()
        await asyncio.wait_for(later, 1)
        queue.release()
        return queue.busy

    assert asyncio.run(scenario()) is False


def test_blob_store_prunes_oldest_beyond_budget(tmp_path):
    store = BlobStore(str(tmp_path), budget=250)
    keys = [f"{i:064x}" for i in range(3)]
    for i, key in enumerate(keys):
        store.put(key, bytes(100))
        os.utime(store.path(key), (1000 + i, 1000 + i))
    assert not store.has(keys[0]) and store.has(keys[1]) and store.has(keys[2])
    # A new store on the same directory (a container starting cold) sees what is there.
    again = BlobStore(str(tmp_path), budget=250)
    assert again.total == 200 and again.has(keys[2])
