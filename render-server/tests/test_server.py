"""The retired raw-scene factory never starts Blender or creates backing stores."""

import pytest
from fastapi.testclient import TestClient

from fury_render import api


@pytest.mark.parametrize("start", [False, True])
@pytest.mark.parametrize("configured", [False, True])
def test_direct_factory_cannot_bypass_retirement(tmp_path, monkeypatch, start, configured):
    def forbidden(*args, **kwargs):
        raise AssertionError("Retired factory must not construct a Service or worker")

    monkeypatch.setattr(api, "Service", forbidden)
    settings = api.Settings(blob_dir=str(tmp_path / "blobs"), frame_dir=str(tmp_path / "frames"))
    with TestClient(api.create_app(settings if configured else None, start=start)) as client:
        for method, path in [("GET", "/warm"), ("POST", "/render"), ("PUT", "/blobs/" + "a" * 64)]:
            response = client.request(method, path)
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "LEGACY_RENDER_DISABLED"
            assert response.json()["error"]["retryable"] is False
        assert client.get("/health").json()["ok"] is False
    assert not (tmp_path / "blobs").exists()
    assert not (tmp_path / "frames").exists()


def test_default_asgi_factory_cannot_start_service(monkeypatch):
    monkeypatch.setattr(api, "Service", lambda *args: pytest.fail("Service was constructed"))
    with TestClient(api.create_app()) as client:
        assert client.post("/render").json()["error"]["code"] == "LEGACY_RENDER_DISABLED"
