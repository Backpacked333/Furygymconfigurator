"""Legacy gateway denies work regardless of origins, tokens, sessions or warm settings."""

import asyncio
import gzip
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from fury_render.gateway import create_gateway
from fury_render.protocol import ProtocolError, decompress
from scene_kit import Kit


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/warm"),
        ("POST", "/render"),
        ("PUT", "/blobs/" + "a" * 64),
        ("POST", "/render/"),
        ("OPTIONS", "/render"),
    ],
)
@pytest.mark.parametrize("warm", [False, True])
def test_legacy_routes_never_dispatch(method, path, warm, monkeypatch):
    monkeypatch.setenv("FURY_WARM", "1")
    monkeypatch.setenv("FURY_BAKE_TOKEN", "test-token")
    monkeypatch.setenv("FURY_ALLOWED_ORIGINS", ".*")
    dispatch = AsyncMock()
    app = create_gateway(
        dispatch,
        origins=".*",
        max_sessions=1000,
        warm=warm,
        idle_seconds=1,
        bake_token="test-token",
    )
    with TestClient(app) as client:
        response = client.request(
            method,
            path,
            params={"session": "shared-warm"},
            content=gzip.compress(b"untrusted scene"),
            headers={"origin": "https://test.example", "x-fury-bake": "test-token"},
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "LEGACY_RENDER_DISABLED"
        assert response.json()["error"]["retryable"] is False
        assert response.headers["cache-control"] == "no-store"
    dispatch.assert_not_called()
    dispatch.assert_not_awaited()


def test_health_is_truthful_and_never_starts_a_worker():
    dispatch = AsyncMock()
    with TestClient(create_gateway(dispatch)) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {
            "ok": False,
            "service": "retired-gateway",
            "paidExecutionAllowed": False,
        }
        assert response.headers["cache-control"] == "no-store"
    dispatch.assert_not_called()


def test_bounded_gzip_and_concatenated_members():
    assert decompress(gzip.compress(b"abc"), 3) == b"abc"
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"x" * 10000), 100)
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"ab") + gzip.compress(b"cd"), 3)
    with pytest.raises(ProtocolError):
        decompress(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff\xff\xff", 100)


def test_texture_urls_are_never_fetched(tmp_path):
    import asyncio
    from fury_render.api import Service, Settings

    kit = Kit()
    scene = kit.scene()
    assert scene["textures"]
    for texture in scene["textures"].values():
        texture["url"] = "http://127.0.0.1:8787/private"
    service = Service(Settings(blob_dir=str(tmp_path)))
    missing = asyncio.run(service.missing(scene))
    assert all(texture["blob"] in missing for texture in scene["textures"].values())


def test_a_call_the_gateway_stops_waiting_for_is_cancelled():
    import asyncio
    from types import SimpleNamespace

    from fury_render.rpc import answer_or_cancel

    class Call:
        def __init__(self, answer=None):
            self.answer, self.cancelled = answer, False

            async def get():
                if self.answer is None:
                    await asyncio.Event().wait()  # Still waiting for a GPU to be placed.
                return self.answer

            async def cancel():
                self.cancelled = True

            self.get, self.cancel = SimpleNamespace(aio=get), SimpleNamespace(aio=cancel)

    async def spawn(call, accepted=None):
        if accepted:
            await accepted.wait()
        return call

    async def scenario():
        answered, stuck, late = Call((200, {}, b"frame")), Call(), Call()
        assert await answer_or_cancel(spawn(answered)) == (200, {}, b"frame")
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(answer_or_cancel(spawn(stuck)), 0.01)
        # The wait ends while Modal is still accepting the call: it is cancelled once it exists.
        accepted = asyncio.Event()
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(answer_or_cancel(spawn(late, accepted)), 0.01)
        assert not late.cancelled
        accepted.set()
        for _ in range(3):
            await asyncio.sleep(0)
        return answered.cancelled, stuck.cancelled, late.cancelled

    # Left queued, these calls would be rendered for no one once the GPU starts.
    assert asyncio.run(scenario()) == (False, True, True)


def test_images_stay_compressed_through_the_private_call():
    import asyncio

    from fastapi import FastAPI
    from fastapi.responses import Response

    from fury_render.rpc import call_app

    image = bytes(range(256)) * 4096
    packed = gzip.compress(image, mtime=0)
    renderer = FastAPI()

    @renderer.post("/render")
    async def render():
        return Response(packed, headers={"Content-Encoding": "gzip", "X-Image-Width": "2"})

    status, headers, content = asyncio.run(call_app(renderer, "POST", "/render", b"{}", "s"))
    assert status == 200 and content == packed
    assert headers["content-encoding"] == "gzip" and "content-length" not in headers
