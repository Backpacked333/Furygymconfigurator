"""Builds blobs and scene descriptions the way the browser does (src/render/cloud.ts)."""

from __future__ import annotations

import gzip
import json
import math
import struct
import zlib

import numpy as np

from fury_render.protocol import digest


def geometry_blob(positions, indices=None, normals=None, uvs=None, groups=None) -> bytes:
    positions = np.asarray(positions, dtype="<f4").reshape(-1, 3)
    parts = []
    offset = 0
    header = {"count": len(positions), "groups": groups or []}

    def add(name, array):
        nonlocal offset
        data = np.ascontiguousarray(array).tobytes()
        header[name] = offset
        parts.append(data)
        offset += len(data)

    add("position", positions)
    header["normal"] = header["uv"] = None
    if normals is not None:
        add("normal", np.asarray(normals, dtype="<f4"))
    if uvs is not None:
        add("uv", np.asarray(uvs, dtype="<f4"))
    header["index"] = None
    if indices is not None:
        idx = np.asarray(indices, dtype="<u4")
        header["index"] = {"offset": offset, "count": len(idx)}
        parts.append(idx.tobytes())
        offset += idx.nbytes
    text = json.dumps(header).encode()
    text += b" " * (-len(text) % 4)
    return b"FRG1" + struct.pack("<I", len(text)) + text + b"".join(parts)


def instances_blob(matrices) -> bytes:
    m = np.asarray(matrices, dtype="<f4").reshape(-1, 16)
    return b"FRI1" + struct.pack("<I", len(m)) + m.tobytes()


def sky_blob(width, height, radiance) -> bytes:
    """`radiance(direction)` in three.js coordinates, laid out like a three.js equirect map."""
    texels = np.zeros((height, width, 3), dtype="<f2")
    for y in range(height):
        v = (y + 0.5) / height
        for x in range(width):
            u = (x + 0.5) / width
            phi = (u - 0.5) * 2 * math.pi
            theta = (v - 0.5) * math.pi
            d = (math.cos(theta) * math.cos(phi), math.sin(theta), math.cos(theta) * math.sin(phi))
            texels[y, x] = radiance(d)
    return b"FRE1" + struct.pack("<II", width, height) + texels.tobytes()


def png(width, height, pixel) -> bytes:
    rows = b"".join(
        b"\x00" + bytes(c for x in range(width) for c in pixel(x, y)) for y in range(height)
    )

    def chunk(kind, data):
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def translation(x, y, z):
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]


def look_at(eye, target):
    """A three.js camera world matrix (column-major) looking from eye at target, Y up."""
    eye = np.asarray(eye, float)
    z = eye - np.asarray(target, float)
    z /= np.linalg.norm(z)
    x = np.cross([0, 1, 0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return [*x, 0, *y, 0, *z, 0, *eye, 1]


class Kit:
    """A small studio: textured floor, a box, an emissive strip, instanced posts, three lights."""

    def __init__(self):
        self.blobs: dict[str, bytes] = {}

    def blob(self, data: bytes) -> str:
        key = digest(data)
        self.blobs[key] = data
        return key

    def scene(self, wall_color=(0.6, 0.3, 0.2)):
        floor = self.blob(
            geometry_blob(
                [(-5, 0, 5), (5, 0, 5), (5, 0, -5), (-5, 0, -5)],
                indices=[0, 1, 2, 0, 2, 3],
                normals=[(0, 1, 0)] * 4,
                uvs=[(0, 0), (4, 0), (4, 4), (0, 4)],
            )
        )
        # a unit box from 12 triangles, flat shaded by duplicated vertices
        verts, norms = [], []
        for axis in range(3):
            for sign in (-1, 1):
                n = [0, 0, 0]
                n[axis] = sign
                u = [0, 0, 0]
                u[(axis + 1) % 3] = 1
                v = [0, 0, 0]
                v[(axis + 2) % 3] = 1
                c = np.array(n, float) * 0.5
                quad = [
                    c - np.array(u) * 0.5 - np.array(v) * 0.5,
                    c + np.array(u) * 0.5 - np.array(v) * 0.5,
                    c + np.array(u) * 0.5 + np.array(v) * 0.5,
                    c - np.array(u) * 0.5 + np.array(v) * 0.5,
                ]
                if sign < 0:
                    quad = quad[::-1]
                for i in (0, 1, 2, 0, 2, 3):
                    verts.append(quad[i])
                    norms.append(n)
        box = self.blob(geometry_blob(verts, normals=norms))
        checker = self.blob(
            png(8, 8, lambda x, y: (220, 220, 220, 255) if (x + y) % 2 else (60, 60, 60, 255))
        )
        posts = self.blob(instances_blob([translation(-3 + 1.5 * i, 0.5, -3) for i in range(5)]))
        sky = self.blob(
            sky_blob(
                32,
                16,
                lambda d: (
                    0.2 + 0.3 * max(d[1], 0),
                    0.3 + 0.4 * max(d[1], 0),
                    0.6 + 0.8 * max(d[1], 0),
                ),
            )
        )
        return {
            "objects": [
                {
                    "id": "floor",
                    "geometry": floor,
                    "materials": ["floor"],
                    "matrix": translation(0, 0, 0),
                },
                {
                    "id": "box",
                    "geometry": box,
                    "materials": ["wall"],
                    "matrix": translation(0, 0.5, 0),
                },
                {
                    "id": "strip",
                    "geometry": box,
                    "materials": ["lamp"],
                    "matrix": translation(2, 0.1, 1),
                },
                {
                    "id": "posts",
                    "geometry": box,
                    "materials": ["wall"],
                    "matrix": translation(0, 0, 0),
                    "instances": posts,
                },
            ],
            "materials": {
                "floor": {
                    "color": [1, 1, 1],
                    "roughness": 0.8,
                    "metalness": 0,
                    "side": 0,
                    "maps": {"map": "checker"},
                },
                "wall": {"color": list(wall_color), "roughness": 0.5, "metalness": 0, "side": 0},
                "lamp": {
                    "color": [1, 1, 1],
                    "roughness": 1,
                    "emissive": [1, 0.8, 0.6],
                    "emissiveIntensity": 6,
                    "side": 2,
                },
            },
            "textures": {
                "checker": {
                    "blob": checker,
                    "srgb": True,
                    "wrap": "repeat",
                    "matrix": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                },
            },
            "lights": [
                {
                    "type": "sun",
                    "direction": [0.4, 0.8, 0.3],
                    "angle": 0.01,
                    "color": [1, 0.95, 0.9],
                    "irradiance": 3,
                },
                {
                    "type": "spot",
                    "position": [0, 4, 2],
                    "direction": [0, -1, -0.3],
                    "angle": 0.6,
                    "penumbra": 0.5,
                    "radius": 0,
                    "color": [1, 0.9, 0.8],
                    "intensity": 20,
                },
                {
                    "type": "area",
                    "shape": "rect",
                    "width": 1,
                    "height": 0.5,
                    "color": [1, 1, 1],
                    "intensity": 4,
                    "matrix": [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -2, 3, 0, 1],
                },
            ],
            "environment": {"blob": sky},
        }


def request(
    scene, eye=(4, 3, 6), target=(0, 0.5, 0), width=64, height=48, samples=16, session="", seq=1
):
    return {
        "session": session,
        "seq": seq,
        "scene": scene,
        "camera": {"matrix": look_at(eye, target), "fov": 45, "near": 0.1, "far": 100},
        "width": width,
        "height": height,
        "quality": {"samples": samples, "threshold": 0.05, "timeLimit": 30},
    }


def gz(data: bytes) -> bytes:
    return gzip.compress(data, mtime=0)
