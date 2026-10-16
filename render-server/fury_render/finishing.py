"""Finishes path-traced frames on the server, as the browser does (src/render/pipeline.ts).

The spin viewer shows many pre-rendered frames, so they travel as small WebP images (about 0.2 MB
at 1200x827) instead of linear half floats (4 MB). The browser's finishing therefore happens here:

- exposure match (a gain);
- emissive bloom (three.js BloomNode with strength 0.16, radius 0.5, threshold 1.4);
- AgX tone mapping at the renderer's exposure (three.js r186);
- sRGB encoding and dither.

The vignette depends on the screen, not the frame (a panorama is viewed a piece at a time), so the
browser still applies it when it shows a frame.
"""

from __future__ import annotations

import io

import numpy as np

# three.js ToneMappingFunctions.js. TSL's mat3(a, b, c) takes columns, so with row vectors the
# product is v @ [a, b, c].
SRGB_TO_REC2020 = np.array(
    [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]], np.float32
)
REC2020_TO_SRGB = np.array(
    [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]],
    np.float32,
)
AGX_INSET = np.array(
    [
        [0.856627153315983, 0.137318972929847, 0.11189821299995],
        [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
        [0.0482516061458583, 0.101439036467562, 0.811302368396859],
    ],
    np.float32,
)
AGX_OUTSET = np.array(
    [
        [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
        [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
        [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
    ],
    np.float32,
)
AGX_MIN_EV, AGX_MAX_EV = -12.47393, 4.026069
SRGB_TO_AGX = (SRGB_TO_REC2020 @ AGX_INSET).astype(np.float32)
LUMINANCE = np.array([0.2126, 0.7152, 0.0722], np.float32)

# BloomNode: bright pass, then five mips blurred progressively at half resolution and below. With
# radius 0.5 every mip's factor mix(f, 1.2 - f, 0.5) is 0.6.
BLOOM_STRENGTH = 0.16
BLOOM_THRESHOLD = 1.4
BLOOM_SMOOTH = 0.01
BLOOM_KERNELS = (6, 10, 14, 18, 22)
BLOOM_MIP_FACTOR = 0.6


def agx(rgb: np.ndarray, exposure: float) -> np.ndarray:
    """three.js AgX tone mapping: linear sRGB in, display-linear sRGB in [0, 1] out."""
    c = (rgb * np.float32(exposure)) @ SRGB_TO_AGX
    c = np.log2(np.maximum(c, 1e-10))
    c = np.clip((c - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0, 1)
    x2 = c * c
    x4 = x2 * x2
    c = (
        15.5 * x4 * x2
        - 40.14 * x4 * c
        + 31.96 * x4
        - 6.868 * x2 * c
        + 0.4298 * x2
        + 0.1191 * c
        - 0.00232
    )
    c = c @ AGX_OUTSET
    c = np.power(np.maximum(c, 0), 2.2)
    c = c @ REC2020_TO_SRGB
    return np.clip(c, 0, 1)


def srgb_encode(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def _gaussian_1d(image: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """BloomNode's separable Gaussian (sigma = radius / 3, truncated at radius), clamped edges."""
    sigma = radius / 3
    offsets = np.arange(-(radius - 1), radius)
    weights = np.exp(-0.5 * offsets**2 / sigma**2)
    weights /= weights.sum()
    pad = [(0, 0)] * image.ndim
    pad[axis] = (radius - 1, radius - 1)
    padded = np.pad(image, pad, mode="edge")
    out = np.zeros_like(image)
    n = image.shape[axis]
    for k, w in enumerate(weights.astype(np.float32)):
        window = padded[k : k + n] if axis == 0 else padded[:, k : k + n]
        out += w * window
    return out


def _half(image: np.ndarray) -> np.ndarray:
    h, w = image.shape[0] // 2 * 2, image.shape[1] // 2 * 2
    if h == 0 or w == 0:
        return image
    a = image[:h, :w]
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


def _resize(image: np.ndarray, height: int, width: int) -> np.ndarray:
    """Bilinear resize with pixel-centre alignment, as texture sampling does."""
    sh, sw = image.shape[:2]
    y = np.clip((np.arange(height) + 0.5) * sh / height - 0.5, 0, sh - 1)
    x = np.clip((np.arange(width) + 0.5) * sw / width - 0.5, 0, sw - 1)
    y0, x0 = np.floor(y).astype(int), np.floor(x).astype(int)
    y1, x1 = np.minimum(y0 + 1, sh - 1), np.minimum(x0 + 1, sw - 1)
    fy = (y - y0).astype(np.float32)[:, None, None]
    fx = (x - x0).astype(np.float32)[None, :, None]
    top = image[y0][:, x0] * (1 - fx) + image[y0][:, x1] * fx
    bottom = image[y1][:, x0] * (1 - fx) + image[y1][:, x1] * fx
    return top * (1 - fy) + bottom * fy


def bloom(hdr: np.ndarray) -> np.ndarray:
    """The glow BloomNode adds to an exposed HDR image."""
    height, width = hdr.shape[:2]
    lum = hdr @ LUMINANCE
    t = np.clip((lum - BLOOM_THRESHOLD) / BLOOM_SMOOTH, 0, 1)
    bright = hdr * (t * t * (3 - 2 * t))[..., None]
    if not bright.any():
        return np.zeros_like(hdr)
    level = _half(bright)
    base = level.shape[:2]
    glow = np.zeros_like(level)
    for radius in BLOOM_KERNELS:
        if min(level.shape[:2]) < 2:
            break
        level = _gaussian_1d(_gaussian_1d(level, radius, 1), radius, 0)
        # Summed at the first mip's size, then scaled up once.
        glow += level if level.shape[:2] == base else _resize(level, *base)
        level = _half(level)
    glow *= np.float32(BLOOM_MIP_FACTOR * BLOOM_STRENGTH)
    # The glow is blurred over several texels, so repeating pixels scales it up as well as
    # bilinear filtering would, at a fraction of the cost.
    up = np.repeat(np.repeat(glow, 2, axis=0), 2, axis=1)[:height, :width]
    if up.shape[:2] != (height, width):
        up = np.pad(up, ((0, height - up.shape[0]), (0, width - up.shape[1]), (0, 0)), mode="edge")
    return up


def traced_key(hdr: np.ndarray) -> float:
    """Mean log luminance on the browser meter's 48x30 grid (pipeline.ts createExposureMeter)."""
    height, width = hdr.shape[:2]
    ys = ((np.arange(30) + 0.5) / 30 * height).astype(int)
    xs = ((np.arange(48) + 0.5) / 48 * width).astype(int)
    samples = hdr[ys][:, xs, :3] @ LUMINANCE
    return float(np.mean(np.log(np.maximum(samples, 1e-4))))


def finish(hdr: np.ndarray, exposure: float, gain: float, glow: bool = True) -> np.ndarray:
    """Linear HDR (rows top down) to display sRGB bytes, HxWx3 uint8."""
    exposed = np.ascontiguousarray(hdr[..., :3], dtype=np.float32) * np.float32(gain)
    if glow:
        exposed = exposed + bloom(exposed)
    display = srgb_encode(agx(exposed, exposure))
    # The browser dithers by a fraction of a level against banding; a fixed pattern keeps frames
    # byte-identical between renders.
    dither = np.random.default_rng(0).random(display.shape[:2], dtype=np.float32)[..., None] - 0.5
    return np.clip(display * 255 + dither + 0.5, 0, 255).astype(np.uint8)


def encode_webp(rgb: np.ndarray, quality: int = 90) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, "WEBP", quality=quality, method=4)
    return buffer.getvalue()
