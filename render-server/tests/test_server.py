"""End-to-end checks of the render server on the CPU (slow: each render is a real Cycles run)."""

from __future__ import annotations

import tempfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from fury_render.api import Settings, create_app
from fury_render.protocol import pack_image, unpack_image

from scene_kit import Kit, gz, request


def decode(response) -> np.ndarray:
    """The test client inflates the gzip transfer encoding, as browsers do."""
    assert response.headers["x-image-format"] == "rgba16f-delta-planes"
    width = int(response.headers["x-image-width"])
    height = int(response.headers["x-image-height"])
    return unpack_image(response.content, width, height)[..., :3]


@pytest.fixture(scope="module")
def client():
    blob_dir = tempfile.mkdtemp(prefix="fury-blobs-")
    app = create_app(Settings(device="cpu", blob_dir=blob_dir, renders_per_minute=600))
    with TestClient(app) as c:
        yield c


def upload_missing(client, kit, response):
    """Uploads what the server asked for; blobs from earlier tests may already be there."""
    if response.status_code == 200:
        return []
    assert response.status_code == 409, response.text
    missing = response.json()["missing"]
    for key in missing:
        r = client.put(f"/blobs/{key}", content=gz(kit.blobs[key]))
        assert r.status_code == 204, r.text
    return missing


def test_health(client):
    body = client.get("/health").json()
    assert body["ok"] and body["device"] == "CPU"


def test_rejects_bad_hash_upload(client):
    r = client.put("/blobs/" + "0" * 64, content=b"not matching")
    assert r.status_code == 400


def test_renders_after_uploading_missing_blobs(client):
    kit = Kit()
    scene = kit.scene()
    assert client.post("/render", json=request(scene)).status_code == 409
    first = client.post("/render", json=request(scene))
    missing = upload_missing(client, kit, first)
    assert len(missing) == len(kit.blobs)
    r = client.post("/render", json=request(scene, seq=2))
    assert r.status_code == 200, r.text
    image = decode(r)
    assert image.shape == (48, 64, 3)
    # the sky (top rows) is blue and bright; nothing is NaN
    top = image[:4].mean(axis=(0, 1))
    assert top[2] > top[0] and top[2] > 0.5
    assert np.isfinite(image).all()
    # the lit floor in the lower half is far from black
    assert image[30:].mean() > 0.1


def test_new_view_reuses_the_scene(client):
    kit = Kit()
    scene = kit.scene()
    upload_missing(client, kit, client.post("/render", json=request(scene)))
    client.post("/render", json=request(scene, seq=2))
    r = client.post("/render", json=request(scene, eye=(-4, 2, 5), seq=3))
    assert r.status_code == 200
    # nothing to rebuild: only the camera moved
    assert int(r.headers["x-prepare-ms"]) < 200


def test_material_edit_changes_the_image(client):
    kit = Kit()
    upload_missing(client, kit, client.post("/render", json=request(kit.scene())))
    red = decode(client.post("/render", json=request(kit.scene((0.8, 0.1, 0.1)), seq=2)))
    blue = decode(client.post("/render", json=request(kit.scene((0.1, 0.1, 0.8)), seq=3)))
    # the box sits in the middle of the frame
    centre = (slice(18, 30), slice(26, 38))
    assert red[centre][..., 0].mean() > red[centre][..., 2].mean()
    assert blue[centre][..., 2].mean() > blue[centre][..., 0].mean()


def test_superseded_requests_are_dropped(client):
    kit = Kit()
    scene = kit.scene()
    upload_missing(client, kit, client.post("/render", json=request(scene, session="s", seq=1)))
    assert client.post("/render", json=request(scene, session="s", seq=5)).status_code == 200
    r = client.post("/render", json=request(scene, session="s", seq=4))
    assert r.status_code == 409 and r.json()["superseded"]


def test_image_packing_is_lossless_at_half_precision():
    rng = np.random.default_rng(1)
    pixels = rng.uniform(0, 40, size=(7, 9, 4)).astype(np.float32)
    pixels[0, 0, 0] = np.inf
    import gzip

    restored = unpack_image(gzip.decompress(pack_image(pixels)), 9, 7)
    expected = (
        np.clip(np.nan_to_num(pixels, posinf=65000), 0, 65000).astype(np.float16).astype(np.float32)
    )
    assert np.array_equal(restored, expected)


def test_rejects_malformed_requests(client):
    bad = request(Kit().scene())
    bad["width"] = bad["height"] = 100000
    assert client.post("/render", json=bad).status_code == 400
    bad = request({"objects": [{"id": "x", "geometry": "nothex", "materials": [], "matrix": []}]})
    assert client.post("/render", json=bad).status_code == 400
