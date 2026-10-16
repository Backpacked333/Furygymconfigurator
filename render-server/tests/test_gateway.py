import gzip
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from fury_render.gateway import create_gateway
from fury_render.protocol import ProtocolError, decompress
from scene_kit import Kit, request


@pytest.fixture
def gateway():
    calls = []

    async def dispatch(method, path, body, client):
        calls.append((method, path, body, client))
        return 200, {"x-device": "test"}, b"result"

    app = create_gateway(dispatch, r"^https://test\.example$")
    with TestClient(app) as client:
        yield client, calls


def test_forwards_renders_and_uploads_without_a_pin(gateway):
    client, calls = gateway
    assert client.get("/health").json()["ok"]
    assert client.post("/auth", json={"pin": "fury"}).status_code in (404, 405)
    response = client.post("/render", json=request(Kit().scene()))
    assert response.status_code == 200 and response.content == b"result"
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1
    data = b"geometry"
    assert (
        client.put(
            "/blobs/" + hashlib.sha256(data).hexdigest(), content=gzip.compress(data)
        ).status_code
        == 200
    )
    assert calls[-1][2] == data


def test_caps_render_time(gateway):
    client, calls = gateway
    body = request(Kit().scene())
    body["quality"] = {"timeLimit": 60}
    assert client.post("/render", json=body).status_code == 200
    forwarded = json.loads(calls[-1][2])
    assert forwarded["quality"]["timeLimit"] == 15


def test_bad_inputs_and_render_throttle(gateway, monkeypatch):
    import fury_render.api as api

    # A frozen clock: the bucket does not refill while the test sends its requests.
    monkeypatch.setattr(api.time, "monotonic", lambda: 1000.0)
    client, calls = gateway
    assert client.post("/render", content=b"[]").status_code == 400
    assert client.put("/blobs/" + "a" * 64, content=b"wrong").status_code == 400
    # The malformed request above took one of the burst of 240.
    body = request(Kit().scene())
    for _ in range(239):
        assert client.post("/render", json=body).status_code == 200
    assert client.post("/render", json=body).status_code == 429
    assert len(calls) == 239


def test_bounded_gzip_and_concatenated_members():
    assert decompress(gzip.compress(b"abc"), 3) == b"abc"
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"x" * 10000), 100)
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"ab") + gzip.compress(b"cd"), 3)
    with pytest.raises(ProtocolError):
        decompress(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff\xff\xff", 100)


def test_gzip_bomb_never_dispatches(gateway, monkeypatch):
    import fury_render.gateway as module

    client, calls = gateway
    monkeypatch.setattr(module, "MAX_SCENE_BYTES", 100)
    assert client.post("/render", content=gzip.compress(b"x" * 1000)).status_code == 400
    assert calls == []


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


def test_cors(gateway):
    client, calls = gateway
    for origin, expected in [("https://test.example", 200), ("https://evil.example", 400)]:
        response = client.options(
            "/render",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert response.status_code == expected
    assert calls == []


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

    async def dispatch(method, path, body, client):
        return await call_app(renderer, method, path, body, client)

    app = create_gateway(dispatch, r"^https://test\.example$")
    with TestClient(app) as client:
        response = client.post("/render", json=request(Kit().scene()))
    # The browser receives the compressed bytes and inflates them itself.
    assert response.headers["content-encoding"] == "gzip"
    assert int(response.headers["content-length"]) == len(packed)
    assert response.content == image and response.headers["x-image-width"] == "2"
