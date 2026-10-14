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
import hashlib
import io
import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageOps, ImageStat
from PIL import __version__ as pillow_version

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public', 'textures')

# id: (resolution, neutralize albedo for tinting, short role[, saturation kept])
PHOTO_SETS = {
    'rubber_tiles': ('2k', False, 'Rubber-look floor'),
    'laminate_floor_02': ('2k', False, 'Oak-look floor'),
    'granite_tile_04': ('2k', True, 'Stone-look floor'),
    'beige_wall_001': ('1k', True, 'Painted interior walls'),
    'oak_veneer_01': ('1k', False, 'Ceiling slats, trims, reformer'),
    'hinoki_planks': ('1k', False, 'Sauna cladding'),
    'teak_veneer': ('1k', False, 'Exterior decking and gazebo', 0.5),
    'leather_white': ('1k', True, 'Upholstery'),
    'rough_linen': ('1k', True, 'Lounger fabric'),
    'rubberized_track': ('1k', True, 'Rubber plates, dumbbells, mats'),
    'painted_metal_shutter': ('1k', True, 'Container roll-up door'),
    'concrete_pavement': ('2k', True, 'Courtyard paving'),
    'leafy_grass': ('1k', False, 'Lawn'),
    'dry_ground_01': ('1k', False, 'Desert ground'),
    'clean_pebbles': ('1k', False, 'Gravel beds'),
    'bark_platanus': ('1k', False, 'Tree bark'),
    'concrete_slab_wall': ('1k', False, 'Board-formed garden wall'),
    'concrete_wall_001': ('1k', False, 'Planters and stepping stones'),
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
    inputs = {}
    for name, key in maps.items():
        url = files[key][resolution]['jpg']['url']
        content = fetch(url)
        inputs[name] = {'url': url, 'sha256': hashlib.sha256(content).hexdigest()}
        image = Image.open(io.BytesIO(content)).convert('RGB')
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
        'inputs': inputs,
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


def manifest():
    """Inventory committed encodings without re-encoding or weakening close-up fidelity."""
    credits = {e['id']: e for e in json.load(open(os.path.join(ROOT, 'sources.json')))}
    procedural_sizes = {'powder_coat': 0.25, 'brushed_metal': 1.5, 'knurling': 0.1}
    maps = {}
    for asset in sorted([*PHOTO_SETS, *procedural_sizes]):
        photo = asset in PHOTO_SETS
        credit = credits.get(asset, {})
        for role in (['albedo', 'normal', 'arm'] if photo else ['normal', 'arm']):
            path = os.path.join(ROOT, asset, role + '.webp')
            content = open(path, 'rb').read()
            width, height = Image.open(io.BytesIO(content)).size
            settings = PHOTO_SETS.get(asset)
            maps[f'{asset}/{role}'] = {
                'file': f'{asset}/{role}.webp',
                'sha256': hashlib.sha256(content).hexdigest(),
                'encodedBytes': len(content),
                'width': width, 'height': height,
                'decodedBytesRGBA': width * height * 4,
                'role': role,
                'colorSpace': 'srgb' if role == 'albedo' else 'none',
                'channels': {'albedo': 'RGB color', 'normal': 'OpenGL tangent +Y', 'arm': 'R=AO G=roughness B=metalness'}[role],
                'repeatFeet': credit.get('sizeFt', [procedural_sizes.get(asset)] * 2),
                'runtimeFormat': 'WebP decoded to RGBA; uncompressed GPU texture',
                'mips': 'runtime generated; trilinear minification',
                'source': credit.get('source', 'scripts/build-textures.py#' + asset),
                'authors': credit.get('authors', ['FURY configurator procedural generator']),
                'license': 'CC0-1.0' if photo else 'project-authored procedural',
                'sourceInput': credit.get('inputs', {}).get(role),
                'encoding': {'format': 'WebP', 'method': 6, 'quality': (90 if role == 'normal' else 84) if photo else (92 if role == 'normal' else 88)},
                'transform': {'neutralize': bool(photo and role == 'albedo' and settings[1]), 'saturation': settings[3] if photo and len(settings) > 3 and role == 'albedo' else 1},
                'fallback': 'deterministic 32px family-color/grain albedo, flat tangent normal, neutral AO and material-family roughness/metalness',
            }
    result = {
        'schema': 1,
        'generator': 'python3 scripts/build-textures.py --manifest-only',
        'sourceRebuild': 'python3 scripts/build-textures.py (Pillow + NumPy; source input hashes recorded on regeneration)',
        'legacySourceNote': 'Existing encodings are retained without recompression. Null sourceInput means original download hash was not recorded; output hashes are verified.',
        'inspectionTools': {'pillow': pillow_version, 'numpy': np.__version__},
        'maps': maps,
    }
    with open(os.path.join(ROOT, 'manifest.json'), 'w') as file:
        json.dump(result, file, indent=2)
        file.write('\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', nargs='*')
    parser.add_argument('--skip-procedural', action='store_true')
    parser.add_argument('--manifest-only', action='store_true')
    args = parser.parse_args()
    if args.manifest_only:
        manifest()
        return
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
    manifest()


if __name__ == '__main__':
    main()
