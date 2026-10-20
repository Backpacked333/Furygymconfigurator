#!/usr/bin/env python3
"""Fetch CC0 Poly Haven PBR sets and bake procedural maps into public/textures.

Run once when the material library changes; the WebP output is committed so the
app never requests remote assets at runtime. Requires Python 3 with Pillow and NumPy.

    python3 scripts/build-textures.py            # fetch + convert everything
    python3 scripts/build-textures.py --only rubber_tiles

Each set is written as <id>/albedo.webp (sRGB), normal.webp (OpenGL, linear) and
arm.webp (R ambient occlusion, G roughness, B metalness), matching three.js
aoMap/roughnessMap/metalnessMap channel conventions.
"""
import argparse
import io
import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageOps, ImageStat

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public', 'textures')

# id: (resolution, neutralize albedo for tinting, short role[, saturation kept])
PHOTO_SETS = {
    'rubber_tiles': ('2k', False, 'Rubber-look floor'),
    'laminate_floor_02': ('2k', False, 'Oak-look floor'),
    'granite_tile_04': ('2k', True, 'Stone-look floor'),
    'beige_wall_001': ('2k', True, 'Painted interior walls'),
    'oak_veneer_01': ('2k', False, 'Ceiling slats, trims, reformer'),
    'hinoki_planks': ('2k', False, 'Sauna cladding'),
    'teak_veneer': ('2k', False, 'Exterior decking and gazebo', 0.5),
    'leather_white': ('1k', True, 'Upholstery'),
    'rough_linen': ('1k', True, 'Lounger fabric'),
    'rubberized_track': ('1k', True, 'Rubber plates, dumbbells, mats'),
    'painted_metal_shutter': ('2k', True, 'Container roll-up door'),
    'concrete_pavement': ('2k', True, 'Courtyard paving'),
    'leafy_grass': ('1k', False, 'Lawn'),
    'dry_ground_01': ('1k', False, 'Desert ground'),
    'clean_pebbles': ('1k', False, 'Gravel beds'),
    'bark_platanus': ('1k', False, 'Tree bark'),
    'concrete_slab_wall': ('2k', False, 'Board-formed garden wall'),
    'concrete_wall_001': ('2k', False, 'Planters and stepping stones'),
    'red_brick_03': ('2k', False, 'Apartment brick facades'),
    'herringbone_pavement': ('2k', True, 'Residential courtyard pavers'),
    'concrete_floor_worn_001': ('2k', True, 'Polished concrete floor'),
    'plywood': ('2k', False, 'Birch plywood interior lining'),
    'japanese_cedar_planks': ('2k', False, 'Cedar interior lining and house cladding', 0.55),
    'white_stucco': ('2k', True, 'Stucco and precast facades'),
}

API = 'https://api.polyhaven.com'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'fury-configurator-texture-build'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def neutralize(image):
    """Remove the photo's hue and normalize brightness so material.color can tint it."""
    gray = ImageOps.grayscale(image)
    mean = ImageStat.Stat(gray).mean[0] / 255
    scale = 0.82 / max(mean, 0.05)
    return gray.point(lambda v: max(0, min(255, round(v * scale)))).convert('RGB')


def desaturate(image, keep):
    """Weathered/oiled timber: keep a fraction of the photo's chroma around its luminance."""
    gray = ImageOps.grayscale(image).convert('RGB')
    return Image.blend(gray, image, keep)


def save(image, path, quality):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image.save(path, 'WEBP', quality=quality, method=6)


def photo_set(asset, resolution, tint, saturation=1.0):
    info = json.loads(fetch(f'{API}/info/{asset}'))
    files = json.loads(fetch(f'{API}/files/{asset}'))
    out = os.path.join(ROOT, asset)
    maps = {'albedo': 'Diffuse', 'normal': 'nor_gl', 'arm': 'arm'}
    for name, key in maps.items():
        url = files[key][resolution]['jpg']['url']
        image = Image.open(io.BytesIO(fetch(url))).convert('RGB')
        if name == 'albedo' and tint:
            image = neutralize(image)
        elif name == 'albedo' and saturation < 1:
            image = desaturate(image, saturation)
        save(image, os.path.join(out, f'{name}.webp'), 90 if name == 'normal' else 84)
    width_mm, height_mm = info['dimensions']
    return {
        'id': asset,
        'name': info['name'],
        'authors': list(info['authors'].keys()),
        'sizeFt': [round(width_mm / 304.8, 3), round(height_mm / 304.8, 3)],
        'source': f'https://polyhaven.com/a/{asset}',
    }


# --- Procedural maps -------------------------------------------------------


def value_noise(size, cells, rng):
    """Seamless value noise: a random lattice tiled 3x3, bicubically upsampled, center crop."""
    grid = rng.random((cells, cells))
    small = Image.fromarray(np.uint8(np.tile(grid, (3, 3)) * 255))
    big = small.resize((size * 3, size * 3), Image.BICUBIC)
    return np.asarray(big, dtype=np.float32)[size : size * 2, size : size * 2] / 255


def fbm(size, base, octaves, seed, gain=0.5):
    rng = np.random.default_rng(seed)
    total, amplitude, norm = np.zeros((size, size), np.float32), 1.0, 0.0
    for octave in range(octaves):
        total += value_noise(size, base * 2**octave, rng) * amplitude
        norm += amplitude
        amplitude *= gain
    return total / norm


def normal_from_height(height, strength):
    """Central-difference normal map (OpenGL convention, +Y up) from a seamless height field."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength
    n = np.stack([-dx, dy, np.ones_like(height)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return Image.fromarray(np.uint8(np.clip((n * 0.5 + 0.5) * 255, 0, 255)))


def arm_image(roughness, metalness):
    ao = np.ones_like(roughness)
    arm = np.stack([ao, np.clip(roughness, 0, 1), np.full_like(roughness, metalness)], axis=-1)
    return Image.fromarray(np.uint8(arm * 255))


def powder_coat(size=512):
    """Orange-peel relief of architectural powder coat and painted container steel."""
    height = fbm(size, 24, 3, 11, 0.5)
    out = os.path.join(ROOT, 'powder_coat')
    save(normal_from_height(height, 3.0), os.path.join(out, 'normal.webp'), 92)
    roughness = 0.45 + (fbm(size, 4, 3, 19) - 0.5) * 0.16
    save(arm_image(roughness, 0.0), os.path.join(out, 'arm.webp'), 88)


def brushed_metal(size=512):
    """Directional micro-scratches of brushed stainless steel along U."""
    rng = np.random.default_rng(23)
    streaks = rng.random((size, 1)).astype(np.float32)
    fine = rng.random((size, size)).astype(np.float32) * 0.15
    height = np.repeat(streaks, size, axis=1) + fine
    height = (height + np.roll(height, 1, axis=1) + np.roll(height, -1, axis=1)) / 3
    out = os.path.join(ROOT, 'brushed_metal')
    save(normal_from_height(height, 0.6), os.path.join(out, 'normal.webp'), 92)
    roughness = 0.24 + np.repeat(streaks, size, axis=1) * 0.14
    save(arm_image(roughness, 1.0), os.path.join(out, 'arm.webp'), 88)


def knurling(size=256, period=16):
    """Diamond knurl relief for barbell, pull-up bar, and dumbbell handles."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    a = np.abs(((x + y) % period) / period - 0.5)
    b = np.abs(((x - y) % period) / period - 0.5)
    height = np.minimum(a, b) * 2
    out = os.path.join(ROOT, 'knurling')
    save(normal_from_height(height, 2.5), os.path.join(out, 'normal.webp'), 92)
    save(arm_image(0.28 + height * 0.25, 1.0), os.path.join(out, 'arm.webp'), 88)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', nargs='*')
    parser.add_argument('--skip-procedural', action='store_true')
    args = parser.parse_args()
    credits = []
    for asset, (resolution, tint, role, *rest) in PHOTO_SETS.items():
        if args.only and asset not in args.only:
            continue
        print('fetching', asset, resolution, file=sys.stderr)
        entry = photo_set(asset, resolution, tint, *rest)
        entry['role'] = role
        entry['resolution'] = resolution
        entry['tinted'] = tint
        credits.append(entry)
    if not args.skip_procedural and not args.only:
        print('baking procedural maps', file=sys.stderr)
        powder_coat()
        brushed_metal()
        knurling()
    if credits:
        path = os.path.join(ROOT, 'sources.json')
        existing = json.load(open(path)) if os.path.exists(path) else []
        merged = {e['id']: e for e in existing}
        merged.update({e['id']: e for e in credits})
        with open(path, 'w') as f:
            json.dump(sorted(merged.values(), key=lambda e: e['id']), f, indent=2)
            f.write('\n')


if __name__ == '__main__':
    main()
