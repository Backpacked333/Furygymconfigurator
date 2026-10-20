"""One isolated Blender image; invoked only inside an admitted single-use GPU Sandbox."""

import json
import math
import re
import os
from pathlib import Path
import subprocess
import sys
import time

from .native_scene import build_lighting
from .validation import digest, MAX_IMAGE_BYTES


def render(root, image_key):
    if os.getuid() == 0:
        raise RuntimeError("non-root-required")
    native = (
        subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        .stdout.strip()
        .splitlines()
    )
    recipe = json.loads((Path(__file__).resolve().parents[2] / "recipe.json").read_text())
    expected_device = recipe.get("gpuDevice", "NVIDIA L40S")
    if expected_device not in ("NVIDIA L40S", "NVIDIA GeForce RTX 5090") or native != [expected_device]:
        raise RuntimeError("registered-GPU-required")
    import bpy
    from PIL import Image
    from mathutils import Vector
    from fury_render.blender import Studio

    if bpy.app.version != (4, 5, 0):
        raise RuntimeError("blender-version")
    job = json.loads((root / "job.json").read_text())
    view = next(v for v in job["views"] if v["imageKey"] == image_key)
    raw = (root / f"{image_key}.json").read_bytes()
    if digest(raw) != view["sceneManifestSha256"]:
        raise RuntimeError("scene-checksum")
    data = json.loads(raw)
    for blob in job["blobs"]:
        content = (root / "blobs" / blob["sha256"]).read_bytes()
        if len(content) != blob["bytes"] or digest(content) != blob["sha256"]:
            raise RuntimeError("blob-checksum")

    def blob_path(key):
        if not re.fullmatch("[a-f0-9]{64}", key):
            raise RuntimeError("invalid-blob-reference")
        return str(root / "blobs" / key)

    studio = Studio(blob_path, device="auto", denoise="cpu")
    devices = bpy.context.preferences.addons["cycles"].preferences.devices
    if (
        studio.device["device"] != "OPTIX"
        or studio.scene.cycles.device != "GPU"
        or any(d.use and d.type != "OPTIX" for d in devices)
    ):
        raise RuntimeError("GPU-fallback-refused")
    scene = data["scene"]
    studio.apply_objects(scene["objects"], scene["materials"], scene["textures"])
    if data["environmentId"] != "studio":
        if not scene["environment"]:
            raise RuntimeError("outdoor-sky-missing")
        studio.apply_environment(scene["environment"])
        studio.apply_lights(scene["lights"])
    build_lighting(studio, data["design"], data["environmentId"])
    studio.apply_camera({**data, "samples": 1024, "threshold": 0, "time_limit": 0})
    studio.camera.data.sensor_fit = "VERTICAL"
    studio.camera.data.angle_y = math.radians(data["camera"]["fov"])
    bpy.context.view_layer.update()
    direction = studio.camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    hit = studio.scene.ray_cast(
        bpy.context.evaluated_depsgraph_get(), studio.camera.location, direction
    )
    if (
        not hit[0]
        or hit[4].name in ("studio-cyclorama", "Plane")
        or "scenery-" in hit[4].name
    ):
        raise RuntimeError("camera-does-not-see-gym")
    s = studio.scene
    s.cycles.use_adaptive_sampling = False
    s.cycles.samples = 1024
    s.cycles.time_limit = 0
    s.render.image_settings.file_format = "PNG"
    s.render.image_settings.color_depth = "8"
    s.render.image_settings.color_mode = "RGB"
    s.view_settings.view_transform = "AgX"
    s.view_settings.look = "AgX - Medium High Contrast"
    s.view_settings.exposure = 0
    png, webp = root / "image.png", root / "image.webp"
    s.render.filepath = str(png)
    completed = []

    def on_complete(*_):
        completed.append(True)

    bpy.app.handlers.render_complete.append(on_complete)
    start = time.monotonic()
    bpy.ops.render.render(write_still=True)
    seconds = time.monotonic() - start
    if (
        not completed
        or s.cycles.samples != 1024
        or s.cycles.use_adaptive_sampling
        or s.cycles.time_limit
    ):
        raise RuntimeError("render-not-complete")
    if not 0 < png.stat().st_size <= 16 * 1024 * 1024:
        raise RuntimeError("PNG-cap")
    with Image.open(png) as image:
        image.load()
        if image.format != "PNG" or image.size != (data["width"], data["height"]):
            raise RuntimeError("PNG-decode")
        image.save(webp, format="WEBP", quality=95, method=6)
    encoded = webp.read_bytes()
    if not 0 < len(encoded) <= MAX_IMAGE_BYTES:
        raise RuntimeError("WebP-cap")
    claim = job["claim"]
    receipt = {
        key: claim[key]
        for key in (
            "contractVersion",
            "jobId",
            "attemptId",
            "workerBuildSha256",
            "recipeBundleSha256",
        )
    }
    receipt.update(
        {
            "imageKey": image_key,
            "design": data["design"],
            "recipeRelease": claim["identity"]["recipeRelease"],
            "sceneManifestSha256": view["sceneManifestSha256"],
            "cameraBindingSha256": view["cameraBindingSha256"],
            "sha256": digest(encoded),
            "bytes": len(encoded),
            "width": data["width"],
            "height": data["height"],
            "mime": "image/webp",
            "samples": 1024,
            "completedSamples": 1024,
            "adaptiveSampling": False,
            "quality": 95,
            "device": native[0],
            "engine": "CYCLES",
            "backend": "OPTIX",
            "blenderVersion": "4.5.0",
            "renderSeconds": seconds,
            "cpuFallback": False,
        }
    )
    (root / "receipt.json").write_text(json.dumps(receipt))
    png.unlink()


if __name__ == "__main__":
    render(Path(sys.argv[1]), sys.argv[2])
