"""Offline source closure and recipe binding; never builds images or contacts a provider."""

import hashlib
import json
from pathlib import Path
import shutil
import sys


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def package(output):
    root = Path(__file__).resolve().parents[1]
    output = Path(output).resolve()
    if output.exists():
        raise RuntimeError("fresh-output-required")
    output.mkdir(mode=0o700)
    paths = {
        p
        for folder in ("src", "patches", "types")
        for p in (root / folder).rglob("*")
        if p.is_file() and ".local-" not in str(p)
    }
    paths.update(root.glob("scripts/native-render-*"))
    paths.update(
        p
        for p in (root / "render-server/on_demand").rglob("*")
        if p.is_file() and p.suffix != ".pyc" and "__pycache__" not in p.parts
    )
    paths.update(
        root / p
        for p in (
            "package.json",
            "package-lock.json",
            "render-server/fury_render/__init__.py",
            "render-server/fury_render/blender.py",
            "render-server/fury_render/protocol.py",
            "render-server/fury_render/finishing.py",
            "render-server/fury_render/strict_construction.py",
            "render-server/requirements.txt",
            "render-server/requirements-construction.in",
            "render-server/requirements-construction.lock",
            "scripts/prototype-fixtures.ts",
            "scripts/build-textures.py",
            "public/textures/sources.json",
        )
    )
    assets = json.loads(
        (root / "src/render/prototype/assetInventory.json").read_text()
    )["files"]
    for asset in assets:
        path = root / asset["path"]
        if (
            path.stat().st_size != asset["bytes"]
            or "sha256:" + checksum(path.read_bytes()) != asset["digest"]
        ):
            raise RuntimeError("pinned-asset-changed")
        paths.add(path)
    files = {}
    for path in sorted(paths):
        if path.is_symlink():
            raise RuntimeError("source-symlink")
        name = str(path.relative_to(root))
        files[name] = checksum(path.read_bytes())
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    subset = lambda prefixes: checksum(
        encode({k: v for k, v in files.items() if k.startswith(prefixes)})
    )
    recipe = {
        "releaseId": "fury-native-five@2",
        "workerBuildSha256": checksum(encode(files)),
        "recipeBundleSha256": subset(
            (
                "src/",
                "public/",
                "scripts/native-render-",
                "render-server/fury_render/",
                "render-server/on_demand/",
            )
        ),
        "geometrySha256": subset(
            (
                "src/render/",
                "src/domain/",
                "src/components/",
                "scripts/native-render-scenery",
            )
        ),
        "materialsSha256": subset(("public/", "src/render/", "src/lib/")),
        "camerasSha256": subset(
            ("src/domain/cameras", "src/domain/presentation", "src/render/prototype/")
        ),
        "rendererSha256": subset(
            ("render-server/fury_render/", "render-server/on_demand/")
        ),
    }
    (output / "native-build.json").write_bytes(
        encode({"files": files, "recipe": recipe})
    )
    (output / "recipe.json").write_bytes(encode(recipe))
    print(json.dumps({"output": str(output), "recipe": recipe, "files": len(files)}))


if __name__ == "__main__":
    package(sys.argv[1])
