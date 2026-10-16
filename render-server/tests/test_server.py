"""End-to-end checks of the render server on the CPU (slow: each render is a real Cycles run)."""

from __future__ import annotations

import gzip
import tempfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from fury_render.api import Settings, create_app
from fury_render.protocol import pack_image, unpack_image

from scene_kit import Kit, geometry_blob, gz, look_at, request, sky_blob


def decode(response) -> np.ndarray:
    """The test client inflates the gzip transfer encoding, as browsers do."""
    assert response.headers["x-image-format"] == "rgba16f-delta-planes"
    width = int(response.headers["x-image-width"])
    height = int(response.headers["x-image-height"])
    return unpack_image(response.content, width, height)[..., :3]


@pytest.fixture(scope="module")
def client():
    blob_dir = tempfile.mkdtemp(prefix="fury-blobs-")
    frame_dir = tempfile.mkdtemp(prefix="fury-frames-")
    app = create_app(
        Settings(device="cpu", blob_dir=blob_dir, frame_dir=frame_dir, renders_per_minute=600)
    )
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
    assert body["ok"] and body["device"] == "CPU" and body["denoise"] == "cpu"


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


def test_file_transfer_stays_compressed(client):
    """Pre-rendered views are cached compressed, so they come as a gzip file, not inflated."""
    kit = Kit()
    scene = kit.scene()
    upload_missing(client, kit, client.post("/render", json=request(scene)))
    inflated = client.post("/render", json=request(scene, seq=2))
    r = client.post("/render", json={**request(scene, seq=3), "transfer": "file"})
    assert r.status_code == 200, r.text
    assert "content-encoding" not in r.headers
    assert r.headers["content-type"] == "application/gzip"
    assert r.content[:2] == b"\x1f\x8b" and len(r.content) < len(inflated.content)
    width = int(r.headers["x-image-width"])
    height = int(r.headers["x-image-height"])
    image = unpack_image(gzip.decompress(r.content), width, height)[..., :3]
    assert np.isfinite(image).all() and image.mean() > 0.1


def test_finished_frames_are_cached(client):
    """Spin frames come back finished as WebP, and an identical request is served from the cache."""
    import io

    from PIL import Image

    kit = Kit()
    body = {**request(kit.scene()), "output": "frame", "finish": {"exposure": 1, "gain": 1.5}}
    first = client.post("/render", json=body)
    if upload_missing(client, kit, first):
        first = client.post("/render", json=body)
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "image/webp"
    assert first.headers["x-cache"] == "miss" and float(first.headers["x-traced-key"]) < 5
    image = Image.open(io.BytesIO(first.content))
    assert image.size == (64, 48) and image.mode == "RGB"
    # Lit and not blown out.
    pixels = np.asarray(image, dtype=float)
    assert 20 < pixels.mean() < 235
    again = client.post("/render", json={**body, "seq": 9})
    assert again.headers["x-cache"] == "hit" and again.content == first.content
    # The browser meters exposure from the key, so it comes back from the cache too.
    assert again.headers["x-traced-key"] == first.headers["x-traced-key"]
    brighter = client.post("/render", json={**body, "finish": {"exposure": 1, "gain": 3}})
    assert brighter.headers["x-cache"] == "miss"
    assert np.asarray(Image.open(io.BytesIO(brighter.content)), dtype=float).mean() > pixels.mean()


def test_panorama_frame(client):
    import io

    from PIL import Image

    kit = Kit()
    body = request(kit.scene(), eye=(0, 1.5, 3), target=(0, 1.5, 2), width=96, height=48)
    body["camera"]["panorama"] = True
    body["output"] = "frame"
    upload_missing(client, kit, client.post("/render", json=body))
    r = client.post("/render", json=body)
    assert r.status_code == 200, r.text
    pixels = np.asarray(Image.open(io.BytesIO(r.content)), dtype=float)
    assert pixels.shape == (48, 96, 3)
    # The sky fills the top rows, the floor the bottom ones.
    assert pixels[:6].mean(axis=(0, 1))[2] > pixels[:6].mean(axis=(0, 1))[0]
    assert abs(pixels[:6].mean() - pixels[-6:].mean()) > 5


def test_glass_is_clear_from_both_sides(client):
    """A window seen from inside shows what is outside, as from outside it shows what is in.

    Each face of a pane is thin glass. Cycles' Fresnel node took the far face, seen from behind,
    for light leaving glass and reflected it totally beyond 41°, so windows were dark mirrors.
    """
    kit = Kit()
    # A pane 3 cm thick around z = 0, as a box's two faces, each facing out; a lamp beyond it on
    # either side; a dark sky.
    pane = kit.blob(
        geometry_blob(
            [(-3, -3, 0.015), (3, -3, 0.015), (3, 3, 0.015), (-3, 3, 0.015)]
            + [(-3, -3, -0.015), (-3, 3, -0.015), (3, 3, -0.015), (3, -3, -0.015)],
            indices=[0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
        )
    )
    lamp = kit.blob(
        geometry_blob(
            [(-3.46, -2, -4), (-3.46, -2, 4), (-3.46, 2, 4), (-3.46, 2, -4)],
            indices=[0, 1, 2, 0, 2, 3],
        )
    )
    scene = {
        "objects": [
            {"id": "pane", "geometry": pane, "materials": ["glass"], "matrix": translation()},
            {"id": "lamp", "geometry": lamp, "materials": ["lamp"], "matrix": translation()},
        ],
        "materials": {
            "glass": {
                "color": [1, 1, 1],
                "transmission": 1,
                "roughness": 0,
                "ior": 1.52,
                "side": 2,
            },
            "lamp": {"color": [0, 0, 0], "emissive": [1, 1, 1], "emissiveIntensity": 4, "side": 2},
        },
        "textures": {},
        "lights": [],
        "environment": {"blob": kit.blob(sky_blob(8, 4, lambda d: (0.01, 0.01, 0.01)))},
    }

    def through(eye, target, seq):
        body = request(scene, width=32, height=24, samples=16, seq=seq)
        body["camera"] = {"matrix": look_at(eye, target), "fov": 20, "near": 0.1, "far": 100}
        r = client.post("/render", json=body)
        if upload_missing(client, kit, r):
            r = client.post("/render", json=body)
        assert r.status_code == 200, r.text
        return decode(r)[8:16, 12:20].mean()

    front = through((3.46, 0, 2), (-3.46, 0, -2), 1)
    back = through((3.46, 0, -2), (-3.46, 0, 2), 2)
    assert front > 1
    assert back == pytest.approx(front, rel=0.2)


def translation():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


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
