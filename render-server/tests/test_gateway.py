import gzip
import hashlib
import time

import pytest
from fastapi.testclient import TestClient

from fury_render.gateway import create_gateway, pin_hash
from fury_render.protocol import ProtocolError, decompress
from scene_kit import Kit, request


@pytest.fixture
def gateway():
    calls = []

    async def dispatch(method, path, body, client):
        calls.append((method, path, body, client))
        return 200, {"x-device": "test"}, b"result"

    app = create_gateway(dispatch, pin_hash("test-pin"), "k" * 64, r"^https://test\.example$")
    with TestClient(app) as client:
        yield client, calls


def login(client):
    response = client.post("/auth", json={"pin": "test-pin"})
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["token"]}


def test_locked_requests_never_start_gpu(gateway):
    client, calls = gateway
    assert client.get("/health").status_code == 200
    assert client.post("/auth", json={"pin": "wrong"}).status_code == 401
    assert client.post("/render", json=request(Kit().scene())).status_code == 401
    assert client.put("/blobs/" + "a" * 64, content=b"bad").status_code == 401
    assert calls == []


def test_unlock_and_forward(gateway):
    client, calls = gateway
    headers = login(client)
    response = client.post("/render", headers=headers, json=request(Kit().scene()))
    assert response.status_code == 200 and response.content == b"result"
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1
    data = b"geometry"
    assert (
        client.put(
            "/blobs/" + hashlib.sha256(data).hexdigest(),
            headers=headers,
            content=gzip.compress(data),
        ).status_code
        == 200
    )
    assert calls[-1][2] == data


def test_expired_tampered_and_wrong_key_tokens(gateway, monkeypatch):
    client, calls = gateway
    headers = login(client)
    original = headers["Authorization"]
    headers["Authorization"] = original[:-1] + ("0" if original[-1] != "0" else "1")
    assert client.post("/render", headers=headers).status_code == 401
    headers["Authorization"] = original
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 3601)
    assert client.post("/render", headers=headers).status_code == 401
    assert calls == []


def test_login_throttle_and_body_limit(gateway):
    client, calls = gateway
    assert client.post("/auth", content=b"x" * 1025).status_code == 413
    for _ in range(4):
        assert client.post("/auth", json={"pin": "wrong"}).status_code == 401
    assert client.post("/auth", json={"pin": "test-pin"}).status_code == 429
    assert calls == []


def test_bad_inputs_and_render_throttle(gateway):
    client, calls = gateway
    headers = login(client)
    assert client.post("/render", headers=headers, content=b"[]").status_code == 400
    assert client.put("/blobs/" + "a" * 64, headers=headers, content=b"wrong").status_code == 400
    for _ in range(2):
        assert (
            client.post("/render", headers=headers, json=request(Kit().scene())).status_code == 200
        )
    assert client.post("/render", headers=headers, json=request(Kit().scene())).status_code == 429
    assert len(calls) == 2


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
    headers = login(client)
    monkeypatch.setattr(module, "MAX_SCENE_BYTES", 100)
    assert (
        client.post("/render", headers=headers, content=gzip.compress(b"x" * 1000)).status_code
        == 400
    )
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
                "Access-Control-Request-Headers": "authorization,content-type",
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

    app = create_gateway(dispatch, pin_hash("test-pin"), "k" * 64, r"^https://test\.example$")
    with TestClient(app) as client:
        response = client.post("/render", headers=login(client), json=request(Kit().scene()))
    # The browser receives the compressed bytes and inflates them itself.
    assert response.headers["content-encoding"] == "gzip"
    assert int(response.headers["content-length"]) == len(packed)
    assert response.content == image and response.headers["x-image-width"] == "2"
