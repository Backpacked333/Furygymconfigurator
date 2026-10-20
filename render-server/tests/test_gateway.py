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
