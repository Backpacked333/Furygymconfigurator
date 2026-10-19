#!/usr/bin/env python3
"""Write 1K copies of the 2K scans for the live 3D view.

The pre-rendered stills draw with the full 2K maps; the live 360 view loads these 1K copies,
which download about four times faster and cost a quarter of the GPU memory. Run after
build-textures.py whenever a 2K set changes. Requires Pillow.

    python3 scripts/build-live-textures.py
"""
import os

from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public', 'textures')
SIZE = 1024


def main():
    for name in sorted(os.listdir(ROOT)):
        folder = os.path.join(ROOT, name)
        if not os.path.isdir(folder):
            continue
        for map_name in ('albedo', 'normal', 'arm'):
            source = os.path.join(folder, f'{map_name}.webp')
            if not os.path.exists(source):
                continue
            image = Image.open(source)
            if image.width <= SIZE:
                continue
            os.makedirs(os.path.join(folder, '1k'), exist_ok=True)
            target = os.path.join(folder, '1k', f'{map_name}.webp')
            image.resize((SIZE, SIZE), Image.LANCZOS).save(target, 'WEBP', quality=88, method=6)
            print(f'{name}/1k/{map_name}.webp', os.path.getsize(target) // 1024, 'kB')


if __name__ == '__main__':
    main()
