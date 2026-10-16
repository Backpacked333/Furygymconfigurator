"""The render queue's order and the blob store's budget (no Blender needed)."""

import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from fury_render.api import PRIORITY, BlobStore, RenderQueue, Settings, create_app, uninterrupted


def test_waiting_views_go_ahead_of_pre_renders():
    async def scenario():
        queue = RenderQueue()
        order = []

        async def job(name, kind, hold=0.0):
            async with queue.turn(PRIORITY[kind]):
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
        await queue.acquire(1)
        gone = asyncio.create_task(queue.acquire(0))
        await asyncio.sleep(0)
        gone.cancel()
        later = asyncio.create_task(queue.acquire(1))
        await asyncio.sleep(0)
        queue.release()
        await asyncio.wait_for(later, 1)
        queue.release()
        return queue.busy

    assert asyncio.run(scenario()) is False


def test_a_render_cancelled_midway_keeps_its_worker_until_it_ends():
    async def scenario():
        queue = RenderQueue()
        rendered = asyncio.Event()
        order = []

        async def blender():
            await rendered.wait()
            order.append("first rendered")
            return "frame"

        async def job(name, work):
            async with queue.turn(1):
                order.append(name)
                return await uninterrupted(work)

        first = asyncio.create_task(job("first", blender()))
        await asyncio.sleep(0.01)
        second = asyncio.create_task(job("second", asyncio.sleep(0, "frame")))
        await asyncio.sleep(0.01)
        # The gateway stopped waiting: the render goes on, and so does the worker's turn.
        first.cancel()
        await asyncio.sleep(0.01)
        assert order == ["first"] and queue.busy
        rendered.set()
        assert await asyncio.wait_for(second, 1) == "frame"
        with pytest.raises(asyncio.CancelledError):
            await first
        return order, queue.busy

    assert asyncio.run(scenario()) == (["first", "first rendered", "second"], False)


def test_uninterrupted_work_reports_its_own_failure():
    async def scenario():
        async def broken():
            raise RuntimeError("the renderer stopped")

        await uninterrupted(broken())

    with pytest.raises(RuntimeError, match="the renderer stopped"):
        asyncio.run(scenario())


def test_renders_side_by_side_on_every_worker():
    async def scenario():
        queue = RenderQueue(workers=2)
        running, most, order = set(), 0, []

        async def job(name, priority):
            nonlocal most
            async with queue.turn(priority) as worker:
                assert worker not in running
                running.add(worker)
                most = max(most, len(running))
                order.append(name)
                await asyncio.sleep(0.02)
                running.discard(worker)

        tasks = [asyncio.create_task(job("a", 5)), asyncio.create_task(job("b", 5))]
        await asyncio.sleep(0.005)
        # Both workers are busy: these wait, the more urgent first.
        tasks += [asyncio.create_task(job("later", 5)), asyncio.create_task(job("now", 0))]
        await asyncio.gather(*tasks)
        return most, order, queue.busy, sorted(queue.free)

    assert asyncio.run(scenario()) == (2, ["a", "b", "now", "later"], False, [0, 1])


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


def test_a_newer_view_drops_the_session_s_queued_requests_at_once(tmp_path):
    """A superseded request answers 409 while the worker is still busy, never reaching it."""
    import json

    from fury_render.api import Service, Settings
    from scene_kit import Kit, request

    kit = Kit()
    scene = kit.scene()
    service = Service(
        Settings(blob_dir=str(tmp_path / "blobs"), frame_dir=str(tmp_path / "frames"), max_queue=2)
    )
    for key, data in kit.blobs.items():
        service.store.put(key, data)
    rendered = []
    service.workers[0].call = lambda message: rendered.append(message) or {"ok": False}

    def superseded(response):
        return response.status_code == 409 and json.loads(response.body) == {"superseded": True}

    async def scenario():
        # A render is in progress on the only worker; it cannot be interrupted.
        await service.queue.acquire(0)
        stale = [
            asyncio.create_task(service.render(request(scene, session="s", seq=1)))
            for _ in range(2)
        ]
        await asyncio.sleep(0.01)
        assert service.waiting == 2 and not any(task.done() for task in stale)
        # The queue is full of them, and the newer view takes their places: it is not told busy.
        newer = asyncio.create_task(service.render(request(scene, session="s", seq=2)))
        await asyncio.sleep(0.01)
        # The older requests are answered while the worker is still busy; the newer one waits on.
        assert all(task.done() for task in stale) and not newer.done()
        assert all(superseded(task.result()) for task in stale)
        assert service.waiting == 1 and service.queue.busy
        # An older view delivered after the newer one (the gateway's calls are not ordered) is
        # answered at once and takes no place either.
        assert superseded(await service.render(request(scene, session="s", seq=1)))
        assert service.waiting == 1 and not newer.done()
        # Its caller gone, the newer one leaves the queue too.
        newer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await newer
        service.queue.release(0)
        return service.waiting, service.queue.busy, rendered, service.pending

    assert asyncio.run(scenario()) == (0, False, [], {})


def test_frames_are_named_by_the_worker_that_made_them(tmp_path):
    """With a worker fallen back to CPU denoising, its frames are named so, and both are served."""
    import numpy as np

    from fury_render.api import Service, Settings, frame_digest, frame_version
    from fury_render.protocol import validate_request
    from scene_kit import Kit, request

    kit = Kit()
    scene = kit.scene()
    service = Service(
        Settings(blob_dir=str(tmp_path / "blobs"), frame_dir=str(tmp_path / "frames"), workers=2)
    )
    for key, data in kit.blobs.items():
        service.store.put(key, data)
    gpu, cpu = service.workers
    gpu.info = {"blender": "4.5.0", "denoise": "gpu"}
    cpu.info = {"blender": "4.5.0", "denoise": "cpu"}
    hdr = np.full((48, 64, 3), 0.5, np.float16)

    def call(message):
        with open(message["out"], "wb") as f:
            np.save(f, hdr)
        stats = {"prepareMs": 1, "renderMs": 1, "device": "test", "width": 64, "height": 48}
        return {"ok": True, "stats": stats}

    gpu.call = cpu.call = call
    body = {**request(scene), "output": "frame", "finish": {"exposure": 1, "gain": 1}}

    async def scenario():
        # Side by side, one on each worker.
        first, second = await asyncio.gather(service.render(body), service.render(body))
        assert first.headers["x-cache"] == second.headers["x-cache"] == "miss"
        again = await service.render(body)
        return again.headers["x-cache"]

    assert asyncio.run(scenario()) == "hit"
    valid = validate_request(body)
    for worker in (gpu, cpu):
        assert service.frames.has(frame_digest(valid, frame_version(worker.info)))
    assert service.versions == [frame_version(gpu.info), frame_version(cpu.info)]


def test_priority_is_clamped_to_the_ring_distance_range():
    from fury_render.protocol import validate_request
    from scene_kit import Kit, request

    body = request(Kit().scene())
    assert validate_request(body)["priority"] is None
    assert validate_request({**body, "priority": 17})["priority"] == 17
    assert validate_request({**body, "priority": 40})["priority"] == 31
    assert validate_request({**body, "priority": -3})["priority"] == 0


def test_frame_names_change_with_the_renderer_and_finishing(monkeypatch):
    from fury_render import finishing
    from fury_render.api import frame_digest, frame_version
    from fury_render.protocol import validate_request
    from scene_kit import Kit, request

    body = validate_request({**request(Kit().scene()), "output": "frame"})
    version = frame_version({"blender": "4.5.0", "denoise": "gpu"})
    current = frame_digest(body, version)
    # Stable: the rest of the worker's info plays no part.
    assert current == frame_digest(
        body, frame_version({"blender": "4.5.0", "denoise": "gpu", "gpus": ["L40S"]})
    )
    assert frame_digest(body, frame_version({"blender": "4.5.1", "denoise": "gpu"})) != current
    assert frame_digest(body, frame_version({"blender": "4.5.0", "denoise": "cpu"})) != current
    monkeypatch.setattr(finishing, "FINISHING_VERSION", finishing.FINISHING_VERSION + 1)
    assert frame_digest(body, frame_version({"blender": "4.5.0", "denoise": "gpu"})) != current


def test_frame_names_change_with_the_bounces_traced(monkeypatch):
    """A frame traced to another depth carries other light: never served as the current one."""
    from fury_render import api, protocol
    from fury_render.api import frame_digest, frame_version
    from fury_render.protocol import validate_request
    from scene_kit import Kit, request

    body = validate_request({**request(Kit().scene()), "output": "frame"})
    info = {"blender": "4.5.0", "denoise": "gpu"}
    current = frame_digest(body, frame_version(info))
    assert frame_version(info)["bounces"] == protocol.BOUNCES == 6
    monkeypatch.setattr(api, "BOUNCES", protocol.BOUNCES + 4)
    assert frame_digest(body, frame_version(info)) != current


def test_warm_answers_as_the_gateway_does_without_starting_anything(tmp_path):
    """The page warms its session on load; the local server has nothing to start, but answers
    alike, so a local run sees the same flow as the cloud (gateway.py /warm)."""
    settings = Settings(blob_dir=str(tmp_path / "blobs"), frame_dir=str(tmp_path / "frames"))
    with TestClient(create_app(settings, start=False)) as client:
        response = client.get("/warm", params={"session": "visitor-one"})
        assert response.status_code == 202
        assert response.json() == {"warming": True, "renderer": "own"}
        assert client.get("/warm").status_code == 202
