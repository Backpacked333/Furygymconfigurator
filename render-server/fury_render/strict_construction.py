"""Private configuration-compiler consumer. Constructs real Cycles data; never renders."""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import tempfile

import numpy as np

from .protocol import parse_geometry

HASH = re.compile(r"^[a-f0-9]{64}$")
POLICY = {
    "mode": "preparation-only",
    "captureAllowed": False,
    "paidExecutionAllowed": False,
    "productionAllowed": False,
    "referenceDispatchAllowed": False,
}
CYCLES = {
    "samples": 1024,
    "use_adaptive_sampling": False,
    "adaptive_threshold": 0.0,
    "time_limit": 0.0,
    "use_sample_subset": False,
    "sample_offset": 0,
    "sample_subset_length": 1024,
    "use_layer_samples": "IGNORE",
    "use_animated_seed": False,
    "seed": 0,
    "max_bounces": 6,
    "diffuse_bounces": 6,
    "glossy_bounces": 6,
    "transmission_bounces": 6,
    "volume_bounces": 0,
    "transparent_max_bounces": 32,
    "sample_clamp_direct": 0.0,
    "sample_clamp_indirect": 10.0,
    "blur_glossy": 0.5,
    "use_denoising": True,
    "denoiser": "OPENIMAGEDENOISE",
    "denoising_use_gpu": False,
    "denoising_input_passes": "RGB_ALBEDO_NORMAL",
    "denoising_prefilter": "FAST",
    "denoising_quality": "HIGH",
}


def _read(path: Path, maximum: int) -> bytes:
    if path.resolve() != path or not path.is_file():
        raise ValueError("Symlink or non-file package member")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, "rb", closefd=False) as f:
            data = f.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("Package member too large")
        return data
    finally:
        os.close(fd)


def _finite(values, length):
    if (
        not isinstance(values, list)
        or len(values) != length
        or any(type(x) not in (float, int) or not math.isfinite(x) for x in values)
    ):
        raise ValueError("Invalid numeric vector")


def read_package(directory: Path, expected_digest: str, *, verified_blobs=None):
    directory = directory.absolute()
    if directory.resolve() != directory or not directory.is_dir():
        raise ValueError("Package root must be an owned real directory")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", expected_digest):
        raise ValueError("Expected trusted compiler digest required")
    raw = _read(directory / "manifest.json", 16 * 1024 * 1024)
    if "sha256:" + hashlib.sha256(raw).hexdigest() != expected_digest:
        raise ValueError("Manifest identity mismatch")
    p = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
    if (p.get("contract"), p.get("status"), p.get("execution")) != (
        "fury.cycles-construction@1",
        "incomplete-conversion-no-render",
        POLICY,
    ) or not p.get("holds"):
        raise ValueError("Construction-only policy required")
    settings = p["settings"]
    required = {
        "renderer": "Cycles",
        "blenderVersion": "4.5.0",
        "requestedSamplesPerPixel": 1024,
        "minimumCompletedSamplesPerPixel": 1024,
        "adaptiveSampling": False,
        "nativeTimeLimitSeconds": 0,
        "partialSuccessAllowed": False,
        "lowerTierFallbackAllowed": False,
        "seed": 0,
        "animatedSeed": False,
        "bounces": {
            "max": 6,
            "diffuse": 6,
            "glossy": 6,
            "transmission": 6,
            "volume": 0,
            "transparent": 32,
        },
        "clamp": {"direct": 0, "indirect": 10, "glossyBlur": 0.5},
        "denoising": {
            "method": "OPENIMAGEDENOISE",
            "device": "CPU",
            "passes": "RGB_ALBEDO_NORMAL",
            "prefilter": "FAST",
            "fallbackAllowed": False,
        },
        "intermediate": {
            "format": "OPEN_EXR",
            "color": "RGBA",
            "depth": 16,
            "compression": "NONE",
            "viewTransform": "Standard",
            "look": "None",
        },
    }
    for key, value in required.items():
        if json.dumps(settings.get(key), sort_keys=True) != json.dumps(value, sort_keys=True):
            raise ValueError(f"Strict setting mismatch: {key}")
    if (p["width"], p["height"]) not in [(1920, 1200), (1200, 1500)]:
        raise ValueError("Unsupported draft reference resolution")
    camera = p["camera"]
    _finite(camera["matrix"], 16)
    if not 1 < camera["fov"] < 179 or not 0 < camera["near"] < camera["far"] <= 2000:
        raise ValueError("Invalid bound camera")
    if (
        p["units"]["length"] != "feet"
        or p["units"]["up"] != "+Y"
        or p["units"]["metresPerFoot"] != 0.3048
    ):
        raise ValueError("Unsupported scene coordinate frame")
    scene = p["scene"]
    if scene["environment"] is not None or scene["lights"]:
        raise ValueError("Lighting conversion is not implemented")
    entries = p["blobs"]
    if not isinstance(entries, list) or not 0 < len(entries) <= 20000:
        raise ValueError("Invalid blob count")
    blobs = {}
    total = 0
    for entry in entries:
        key = entry["hash"]
        if not HASH.fullmatch(key) or key in blobs or entry["kind"] not in ["geometry", "texture"]:
            raise ValueError("Invalid blob identity")
        size = entry["bytes"]
        if type(size) is not int or not 0 < size <= 64 * 1024 * 1024:
            raise ValueError("Invalid blob size")
        total += size
        if total > 512 * 1024 * 1024:
            raise ValueError("Package byte cap exceeded")
        data = _read(directory / "blobs" / key, size)
        if len(data) != size or hashlib.sha256(data).hexdigest() != key:
            raise ValueError("Blob integrity mismatch")
        if entry["kind"] == "geometry":
            g = parse_geometry(data)
            if (
                g.normals is None
                or g.uvs is None
                or any(not np.isfinite(v).all() for v in [g.positions, g.normals, g.uvs])
            ):
                raise ValueError("Incomplete or invalid geometry")
        else:
            from PIL import Image

            with Image.open(io.BytesIO(data)) as image:
                if image.format != "WEBP" or not 0 < image.width * image.height <= 4096 * 4096:
                    raise ValueError("Unapproved texture encoding/dimensions")
                image.verify()
        if verified_blobs is not None:
            verified_blobs[key] = data
        blobs[key] = entry["kind"]
    if len(scene["objects"]) > 20000:
        raise ValueError("Too many scene objects")
    ids = set()
    for obj in scene["objects"]:
        if obj["id"] in ids or blobs.get(obj["geometry"]) != "geometry":
            raise ValueError("Duplicate object or missing geometry")
        ids.add(obj["id"])
        _finite(obj["matrix"], 16)
        if not obj["materials"] or any(m not in scene["materials"] for m in obj["materials"]):
            raise ValueError("Missing material")
    for texture in scene["textures"].values():
        if (
            set(texture) != {"blob", "srgb", "wrap", "matrix"}
            or blobs.get(texture["blob"]) != "texture"
        ):
            raise ValueError("Unknown texture or remote texture reference")
        _finite(texture["matrix"], 9)
    for material in scene["materials"].values():
        if any(key not in scene["textures"] for key in material["maps"].values()):
            raise ValueError("Missing material texture")
    return p


def apply_strict_settings(scene):
    for key, value in CYCLES.items():
        if not hasattr(scene.cycles, key):
            raise RuntimeError(f"Unsupported Blender setting: {key}")
        setattr(scene.cycles, key, value)
    scene.cycles.device = "CPU"
    scene.render.engine = "CYCLES"
    scene.render.resolution_percentage = 100
    scene.render.use_border = False
    scene.render.use_crop_to_border = False
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "16"
    scene.render.image_settings.exr_codec = "NONE"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.3048
    for layer in scene.view_layers:
        layer.samples = 0
    verify_strict_settings(scene)


def verify_strict_settings(scene):
    for key, value in CYCLES.items():
        if getattr(scene.cycles, key) != value:
            raise RuntimeError(f"Strict setting changed: {key}")
    if (
        scene.cycles.device != "CPU"
        or scene.render.engine != "CYCLES"
        or scene.render.resolution_percentage != 100
        or scene.render.use_border
        or scene.render.use_crop_to_border
    ):
        raise RuntimeError("Strict frame/device settings changed")
    output = scene.render.image_settings
    if (output.file_format, output.color_mode, output.color_depth, output.exr_codec) != (
        "OPEN_EXR",
        "RGBA",
        "16",
        "NONE",
    ):
        raise RuntimeError("Strict lossless output settings changed")
    if (
        scene.view_settings.view_transform,
        scene.view_settings.look,
        scene.view_settings.exposure,
        scene.view_settings.gamma,
    ) != ("Standard", "None", 0, 1):
        raise RuntimeError("Strict color management changed")
    if any(layer.samples != 0 for layer in scene.view_layers):
        raise RuntimeError("Per-layer sample override is forbidden")


def construct(directory: Path, expected_digest: str):
    verified_blobs = {}
    p = read_package(directory, expected_digest, verified_blobs=verified_blobs)
    import bpy

    if bpy.app.version != (4, 5, 0):
        raise RuntimeError("Blender 4.5.0 required; no fallback")
    from .blender import Studio

    class ConstructionStudio(Studio):
        def render(self, *args, **kwargs):
            raise RuntimeError("Construction only: strict rendering remains disabled")

    # Consume the bytes actually verified, not files that could change after validation.
    with tempfile.TemporaryDirectory(prefix="fury-verified-cycles-") as staging:
        blobs = Path(staging)
        for key, data in verified_blobs.items():
            with (blobs / key).open("xb") as f:
                f.write(data)
        studio = ConstructionStudio(lambda key: str(blobs / key), device="CPU", denoise="cpu")
        scene = p["scene"]
        studio.apply_objects(scene["objects"], scene["materials"], scene["textures"])
        for image, _last_used in studio.images.values():
            image.pack()
    studio.apply_lights([])
    studio.apply_environment(None)
    studio.apply_camera({**p, "samples": 1024, "threshold": 0, "time_limit": 0})
    studio.camera.data.sensor_fit = "VERTICAL"
    studio.camera.data.angle_y = math.radians(p["camera"]["fov"])
    apply_strict_settings(studio.scene)
    receipt = {
        "contract": "fury.cycles-construction-receipt@1",
        "packageDigest": expected_digest,
        "blenderVersion": bpy.app.version_string,
        "blenderBuildHash": bpy.app.build_hash.decode(),
        "objectCount": len(studio.objects),
        "meshCount": len(bpy.data.meshes),
        "materialCount": len(studio.materials),
        "textureCount": len(studio.images),
        "verticalFovDegrees": math.degrees(studio.camera.data.angle_y),
        "width": studio.scene.render.resolution_x,
        "height": studio.scene.render.resolution_y,
        "cameraMatrix": [
            studio.camera.matrix_world[row][col] for col in range(4) for row in range(4)
        ],
        "strictSettings": CYCLES,
        "renderCalls": 0,
        "completedSamplesPerPixel": None,
        "renderAllowed": False,
        "qualified": False,
        "holds": p["holds"],
    }
    return studio, receipt
