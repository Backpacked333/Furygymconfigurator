"""Server-side finishing of spin frames (no Blender needed)."""

from __future__ import annotations

import numpy as np
import pytest

from fury_render import finishing


def halo(width: int, height: int) -> tuple[float, int]:
    """A lone highlight's glow along its row: RMS radius, and pixels above 2% of its peak."""
    hdr = np.zeros((height, width, 3), np.float32)
    hdr[height // 2, width // 2] = 40.0  # well over the bloom threshold
    row = finishing.bloom(hdr)[height // 2] @ finishing.LUMINANCE
    x = np.arange(width) - np.argmax(row)
    return float(np.sqrt((row * x**2).sum() / row.sum())), int((row > row.max() * 0.02).sum())


def test_bloom_radii_scale_with_the_frame_width():
    assert finishing.bloom_kernels(1200) == (1, finishing.BLOOM_KERNELS)
    assert finishing.bloom_kernels(600) == (1, (3, 5, 7, 9, 11))
    assert finishing.bloom_kernels(2399) == (1, (12, 20, 28, 36, 44))
    # A thumbnail still blurs, if barely.
    assert finishing.bloom_kernels(40) == (1, (1, 1, 1, 1, 1))
    # From twice the reference width on, the same radii on a frame halved once more per doubling.
    assert finishing.bloom_kernels(2400) == (2, finishing.BLOOM_KERNELS)
    assert finishing.bloom_kernels(4800) == (3, finishing.BLOOM_KERNELS)
    assert finishing.bloom_kernels(8192) == (3, (10, 17, 24, 31, 38))


def test_midtone_surfaces_do_not_glow_but_practical_highlights_still_do():
    wall = np.full((100, 160, 3), 2.0, dtype=np.float32)
    assert not finishing.bloom(wall).any()
    wall[48:52, 40:120] = 8.0
    glow = finishing.bloom(wall)
    assert np.isfinite(glow).all()
    assert glow[50, 80].max() > 0
    # A fixture must not turn the whole wall into a haze.
    assert glow[25, 80].max() < 0.1


def test_bloom_work_is_bounded_whatever_the_frame_width():
    """The blurred image is 600 to 1200 px wide and the radii at most twice the kernels' pixels."""
    for width in (1200, 1800, 2399, 2400, 3200, 4800, 8191, 8192):
        halvings, radii = finishing.bloom_kernels(width)
        assert 600 <= width / 2**halvings < 1200
        assert all(k <= r <= 2 * k for k, r in zip(finishing.BLOOM_KERNELS, radii))


def test_a_highlight_s_halo_scales_with_the_frame_width():
    """A 1x preview and the full-resolution frame glow alike, relative to their size."""
    radius, width = halo(600, 400)
    assert radius > 8 and width > 12
    for factor in (2, 4, 8):
        # 1200, 2400 (halved further before blurring) and 4800 px wide.
        full_radius, full_width = halo(600 * factor, 400 * factor)
        assert full_radius == pytest.approx(factor * radius, rel=0.1)
        assert full_width == pytest.approx(factor * width, rel=0.2)
