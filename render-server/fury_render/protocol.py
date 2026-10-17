"""Wire formats shared by the web process and the Blender worker.

The browser describes the path-traced form of its scene as JSON (objects, materials, textures,
lights, sky) that refers to binary blobs by the SHA-256 of their uncompressed content. Blobs are
uploaded once (optionally gzip-compressed) and cached, so a new view or a material edit sends only
the small description. See src/render/cloud.ts for the browser side.

Binary blobs, all little-endian:

- Geometry  ``FRG1`` | u32 header length | JSON header (space padded to 4 bytes) | payload.
  The header gives the vertex ``count``, payload byte offsets of ``position`` (f32 x3), ``normal``
  and ``uv`` (f32 x3 / x2, or null), ``index`` ({offset, count} of u32, or null) and ``groups``
  ([start, count, materialIndex] in index units, as in three.js).
- Instances ``FRI1`` | u32 count | f32 x16 per instance (column-major local matrices).
- Sky       ``FRE1`` | u32 width | u32 height | f16 RGB per texel, rows from v = 0 upward, laid
  out like a three.js equirectangular DataTexture.
- Textures are image files (PNG, JPEG, WebP) as served.

Rendered images go back as linear half-float RGBA, rows top down, with each 16-bit value replaced
by its difference from the same channel of the pixel to its left and the result split into a
plane of high bytes followed by a plane of low bytes. Sent with ``Content-Encoding: gzip``, the
browser inflates it natively and undoes the delta in one pass; it is lossless and decodes about
fifteen times faster in JavaScript than a DWA-compressed OpenEXR of the same image.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
import struct
import zlib
from dataclasses import dataclass

import numpy as np

HASH = re.compile(r"^[0-9a-f]{64}$")

# Request limits: generous for the configurator, small enough to bound a render's cost.
MAX_PIXELS = 3840 * 2400
# A 360° panorama for the interior: an equirectangular image, twice as wide as it is high.
MAX_PANORAMA_PIXELS = 8192 * 4096
MAX_SAMPLES = 4096
MAX_TIME_LIMIT = 60.0
MAX_BLOB_BYTES = 128 * 1024 * 1024
MAX_OBJECTS = 20000
MAX_INSTANCES = 200000
# Light bounces a frame is traced with, the browser's tracer and Cycles alike (pathtrace.ts
# maxBounces, blender.py): what a room lit through its glazing needs, and no more. Part of a
# stored frame's name (api.py frame_version), so frames traced deeper are not served as these.
BOUNCES = 6


class ProtocolError(ValueError):
    """The request is malformed; reported to the client as 400."""


def decompress(data: bytes, limit: int = MAX_BLOB_BYTES) -> bytes:
    """Uploads may be gzip-compressed; blobs are stored and hashed uncompressed."""
    if data[:2] == b"\x1f\x8b":
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
                data = stream.read(limit + 1)
        except (OSError, EOFError, zlib.error) as error:
            raise ProtocolError("invalid gzip") from error
    if len(data) > limit:
        raise ProtocolError("decompressed request too large")
    return data


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class Geometry:
    positions: np.ndarray  # (n, 3) f32
    normals: np.ndarray | None  # (n, 3) f32
    uvs: np.ndarray | None  # (n, 2) f32
    indices: np.ndarray  # (m,) u32, triangle list (synthesized when the geometry is not indexed)
    groups: list[tuple[int, int, int]]  # (start, count, material index) in index units


def parse_geometry(data: bytes) -> Geometry:
    if data[:4] != b"FRG1":
        raise ProtocolError("not a geometry blob")
    (length,) = struct.unpack_from("<I", data, 4)
    header = json.loads(data[8 : 8 + length].decode("utf-8"))
    base = 8 + length
    count = int(header["count"])

    def floats(offset, size):
        if offset is None:
            return None
        start = base + int(offset)
        array = np.frombuffer(data, dtype="<f4", count=count * size, offset=start)
        return array.reshape(count, size)

    positions = floats(header["position"], 3)
    normals = floats(header.get("normal"), 3)
    uvs = floats(header.get("uv"), 2)
    index = header.get("index")
    if index:
        indices = np.frombuffer(
            data, dtype="<u4", count=int(index["count"]), offset=base + int(index["offset"])
        )
    else:
        indices = np.arange(count, dtype=np.uint32)
    if len(indices) % 3:
        raise ProtocolError("geometry is not a triangle list")
    if len(indices) and int(indices.max()) >= count:
        raise ProtocolError("geometry index out of range")
    groups = [(int(s), int(c), int(m)) for s, c, m in header.get("groups") or []]
    return Geometry(positions, normals, uvs, indices, groups)


def parse_instances(data: bytes) -> np.ndarray:
    if data[:4] != b"FRI1":
        raise ProtocolError("not an instance blob")
    (count,) = struct.unpack_from("<I", data, 4)
    if count > MAX_INSTANCES:
        raise ProtocolError("too many instances")
    return np.frombuffer(data, dtype="<f4", count=count * 16, offset=8).reshape(count, 16)


def parse_environment(data: bytes) -> tuple[int, int, np.ndarray]:
    """Returns width, height and RGBA f32 texels in Blender's pixel order (rows bottom up)."""
    if data[:4] != b"FRE1":
        raise ProtocolError("not a sky blob")
    width, height = struct.unpack_from("<II", data, 4)
    rgb = np.frombuffer(data, dtype="<f2", count=width * height * 3, offset=12)
    rgba = np.ones((width * height, 4), dtype=np.float32)
    rgba[:, :3] = rgb.reshape(-1, 3)
    return width, height, rgba


IMAGE_FORMAT = "rgba16f-delta-planes"


def pack_image(pixels: np.ndarray) -> bytes:
    """Linear RGBA float pixels (rows top down) as the gzip-compressed wire image."""
    clean = np.nan_to_num(pixels, nan=0.0, posinf=65000.0, neginf=0.0)
    half = np.clip(clean, 0.0, 65000.0).astype(np.float16)
    values = half.view(np.uint16).astype(np.int32)
    delta = values.copy()
    delta[:, 1:] -= values[:, :-1]
    delta = (delta & 0xFFFF).astype(np.uint16)
    planes = np.concatenate(
        [(delta >> 8).astype(np.uint8).ravel(), (delta & 0xFF).astype(np.uint8).ravel()]
    )
    return gzip.compress(planes.tobytes(), compresslevel=3, mtime=0)


def unpack_image(data: bytes, width: int, height: int) -> np.ndarray:
    """Inverse of pack_image after inflating: RGBA float32 rows top down (for tests)."""
    planes = np.frombuffer(data, dtype=np.uint8)
    n = width * height * 4
    delta = (planes[:n].astype(np.uint16) << 8) | planes[n : 2 * n]
    values = np.cumsum(delta.reshape(height, width, 4).astype(np.uint32), axis=1) & 0xFFFF
    return values.astype(np.uint16).view(np.float16).astype(np.float32)


def _hash(value, what: str) -> str:
    if not isinstance(value, str) or not HASH.match(value):
        raise ProtocolError(f"bad {what} hash")
    return value


def required_blobs(scene: dict) -> list[tuple[str, str | None]]:
    """Every blob a scene description refers to, with the URL it may be fetched from."""
    blobs: dict[str, str | None] = {}
    objects = scene.get("objects") or []
    if len(objects) > MAX_OBJECTS:
        raise ProtocolError("too many objects")
    for item in objects:
        blobs[_hash(item.get("geometry"), "geometry")] = None
        if item.get("instances") is not None:
            blobs[_hash(item["instances"], "instances")] = None
    for texture in (scene.get("textures") or {}).values():
        url = texture.get("url")
        blobs[_hash(texture.get("blob"), "texture")] = url if isinstance(url, str) else None
    environment = scene.get("environment")
    if environment:
        blobs[_hash(environment.get("blob"), "sky")] = None
    return list(blobs.items())


def validate_request(body: dict) -> dict:
    """Checks the shape and limits of a render request and returns its normalized settings."""
    try:
        width = int(body["width"])
        height = int(body["height"])
        camera = body["camera"]
        matrix = [float(v) for v in camera["matrix"]]
        fov = float(camera["fov"])
        quality = body.get("quality") or {}
        samples = int(quality.get("samples", 1024))
        threshold = float(quality.get("threshold", 0.01))
        time_limit = float(quality.get("timeLimit", 20))
        scene = body["scene"]
        panorama = bool(camera.get("panorama", False))
        output = str(body.get("output", "image"))
        finish = body.get("finish") or {}
        exposure = float(finish.get("exposure", 1))
        gain = float(finish.get("gain", 1))
        glow = bool(finish.get("glow", True))
        priority = body.get("priority")
        priority = None if priority is None else int(priority)
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise ProtocolError(f"malformed request: {error}") from error
    limit = MAX_PANORAMA_PIXELS if panorama else MAX_PIXELS
    if width < 1 or height < 1 or width * height > limit:
        raise ProtocolError("image size out of range")
    if output not in ("image", "frame"):
        raise ProtocolError("unknown output")
    if not (0.01 <= exposure <= 100 and 0.01 <= gain <= 100):
        raise ProtocolError("bad finish")
    if len(matrix) != 16 or not 1 <= fov <= 170:
        raise ProtocolError("bad camera")
    if not isinstance(scene, dict):
        raise ProtocolError("bad scene")
    return {
        "width": width,
        "height": height,
        "camera": {
            "matrix": matrix,
            "fov": fov,
            "near": float(camera.get("near", 0.1)),
            "far": float(camera.get("far", 10000)),
            "panorama": panorama,
        },
        "samples": max(1, min(MAX_SAMPLES, samples)),
        "threshold": max(0.0, min(0.5, threshold)),
        "time_limit": max(0.5, min(MAX_TIME_LIMIT, time_limit)),
        "scene": scene,
        # "image": linear half floats for the browser to finish; "frame": a finished WebP.
        "output": output,
        "finish": {"exposure": exposure, "gain": gain, "glow": glow},
        "priority": None if priority is None else max(0, min(31, priority)),
    }
