"""Offline source closure and recipe binding; never builds images or contacts a provider."""

import hashlib
import json
from pathlib import Path
import sys


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def registration(files):
    subset = lambda prefixes: checksum(
        encode({k: v for k, v in files.items() if k.startswith(prefixes)})
    )
    return {
        "releaseId": "fury-native-five@2",
        "workerBuildSha256": checksum(encode(files)),
        "recipeBundleSha256": subset(("src/", "public/", "scripts/native-render-",
                                      "render-server/fury_render/", "render-server/on_demand/")),
        "geometrySha256": subset(("src/render/", "src/domain/", "src/components/",
                                  "scripts/native-render-scenery")),
        "materialsSha256": subset(("public/", "src/render/", "src/lib/")),
        "camerasSha256": subset(("src/domain/cameras", "src/domain/presentation",
                                 "src/render/prototype/")),
        "rendererSha256": subset(("render-server/fury_render/", "render-server/on_demand/")),
    }


def write_package(output, files, sources, metadata=None):
    output = Path(output).resolve()
    if output.exists():
        raise RuntimeError("fresh-output-required")
    output.mkdir(mode=0o700)
    for name, source in sources.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source)
    recipe = registration(files)
    manifest = {"files": files, "recipe": recipe, **(metadata or {})}
    (output / "native-build.json").write_bytes(encode(manifest))
    (output / "recipe.json").write_bytes(encode(recipe))
    return manifest


def queue_upgrade(base, output):
    base = Path(base).resolve()
    manifest = json.loads((base / "native-build.json").read_text())
    if manifest["recipe"] != registration(manifest["files"]) or json.loads(
        (base / "recipe.json").read_text()
    ) != manifest["recipe"]:
        raise RuntimeError("base-registration-mismatch")
    sources = {}
    for name, expected in manifest["files"].items():
        path = base / name
        if (Path(name).is_absolute() or '..' in Path(name).parts or path.is_symlink()
                or not path.resolve().is_relative_to(base)):
            raise RuntimeError("unsafe-source-path")
        data = path.read_bytes()
        if checksum(data) != expected:
            raise RuntimeError("base-source-drift")
        sources[name] = data
    replacements = {
        "src/render-library/workerProtocol.ts": [
            ("maxActiveJobsPerSession: 1,", "maxActiveJobsPerSession: 2,"),
            ("maxActiveJobsPerSession: z.literal(1),",
             "maxActiveJobsPerSession: z.number().int().positive().max(2),"),
        ],
        "render-server/on_demand/validation.py": [
            ('        ("maxContainers", 2),\n',
             '        ("maxContainers", 2),\n        ("maxActiveJobsPerSession", 2),\n'
             '        ("maxCreatesPerSessionPerHour", 3),\n'),
        ],
    }
    for name, pairs in replacements.items():
        source = sources[name].decode()
        for old, new in pairs:
            if source.count(old) != 1:
                raise RuntimeError("incompatible-base-worker")
            source = source.replace(old, new)
        sources[name] = source.encode()
    files = {name: checksum(data) for name, data in sources.items()}
    changes = {name: {"before": manifest["files"][name], "after": files[name]}
               for name in replacements}
    return write_package(output, files, sources, {
        "workerRevision": "fury-native-queue-worker@1",
        "compatibleWithWorkerBuildSha256": manifest["recipe"]["workerBuildSha256"],
        "changes": changes,
    })


def package(output):
    root = Path(__file__).resolve().parents[1]
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
    files, sources = {}, {}
    for path in sorted(paths):
        if path.is_symlink():
            raise RuntimeError("source-symlink")
        name = str(path.relative_to(root))
        files[name] = checksum(path.read_bytes())
        sources[name] = path.read_bytes()
    return write_package(output, files, sources)


if __name__ == "__main__":
    result = (queue_upgrade(sys.argv[2], sys.argv[3]) if sys.argv[1] == '--queue-upgrade'
              else package(sys.argv[1]))
    print(json.dumps({k: v for k, v in result.items() if k != 'files'}))
