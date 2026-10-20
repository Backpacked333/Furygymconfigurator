"""Generates src/render/agxInverse.bin: Blender's AgX "Medium High Contrast" view, inverted.

The library's Cycles images (render-server/on_demand/renderer.py) are Blender 4.5.0 renders shown
through the AgX view transform with the "AgX - Medium High Contrast" look at exposure 0, saved as
8-bit sRGB. The 360° view seeds its first traced view with the image it opens on, which needs the
scene-linear light the image shows: this table maps an image's code values back to it.

The forward transform is Blender's own OpenColorIO config, read from the bpy 4.5.0 wheel the
render server pins; the inverse is OpenColorIO's. The table is sampled on a shaper of the code
values c, u = acos(1 - 2 c^0.6) / pi (finer near black and near white, where the curve is
steepest), and stores log2 of the linear Rec.709 values, which interpolate smoothly where the
linear ones would not. Read tetrahedrally (as colour LUTs are, so greys stay grey), it is within
about 1% of OpenColorIO's own inverse below white.

Layout: SIZE^3 entries, red fastest, then green, then blue; three little-endian float16 each
(log2 of linear red, green, blue). Read by src/render/agxInverse.ts.

    pip download --no-deps --only-binary=:all: --python-version 3.11 \
        --platform manylinux_2_28_x86_64 bpy==4.5.0
    unzip bpy-4.5.0-*.whl 'bpy/4.5/datafiles/colormanagement/*'
    pip install opencolorio numpy
    python scripts/agx-inverse.py bpy/4.5/datafiles/colormanagement/config.ocio
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import PyOpenColorIO as ocio

SIZE = 25
SHAPER = 0.6
LOOK = "AgX - Medium High Contrast"
# The darkest value kept: below it the 8-bit image holds no information anyway.
FLOOR = 2.0**-14
OUT = Path(__file__).resolve().parent.parent / "src" / "render" / "agxInverse.bin"


def processor(config: ocio.Config, direction: ocio.TransformDirection):
    transform = ocio.DisplayViewTransform(
        src="Linear Rec.709", display="sRGB", view="AgX", direction=direction
    )
    pipeline = ocio.LegacyViewingPipeline()
    pipeline.setDisplayViewTransform(transform)
    pipeline.setLooksOverrideEnabled(True)
    pipeline.setLooksOverride(LOOK)
    return pipeline.getProcessor(config).getDefaultCPUProcessor()


def main(config_path: str) -> None:
    config = ocio.Config.CreateFromFile(config_path)
    inverse = processor(config, ocio.TRANSFORM_DIR_INVERSE)
    forward = processor(config, ocio.TRANSFORM_DIR_FORWARD)
    u = np.linspace(0, 1, SIZE, dtype=np.float64)
    nodes = (((1 - np.cos(np.pi * u)) / 2) ** (1 / SHAPER)).astype(np.float32)
    blue, green, red = np.meshgrid(nodes, nodes, nodes, indexing="ij")
    codes = np.ascontiguousarray(np.stack([red, green, blue], -1).reshape(-1, 3), np.float32)
    linear = codes.copy()
    inverse.applyRGB(linear)
    table = np.log2(np.maximum(linear, FLOOR)).astype("<f2")
    OUT.write_bytes(table.tobytes())
    # A check: middle grey and white through the look and back.
    probe = np.array([[0.18, 0.18, 0.18], [1, 1, 1]], np.float32)
    shown = probe.copy()
    forward.applyRGB(shown)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes); 0.18 shows as {shown[0, 0]:.4f}, 1 as {shown[1, 0]:.4f}")


if __name__ == "__main__":
    main(sys.argv[1])
