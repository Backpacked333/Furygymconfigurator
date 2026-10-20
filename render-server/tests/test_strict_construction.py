import hashlib
import json
import math
import os
from pathlib import Path
import subprocess

import numpy as np
import pytest

from fury_render.strict_construction import (
    construct,
    read_package,
    verify_strict_settings,
    apply_strict_settings,
)

ROOT = Path(__file__).resolve().parents[2]


def identity(directory):
    return "sha256:" + hashlib.sha256((directory / "manifest.json").read_bytes()).hexdigest()


@pytest.fixture(scope="session")
def packages(tmp_path_factory):
    output = tmp_path_factory.mktemp("cycles-construction")
    script = """
      import {createPrototypeFixtures} from './src/render/prototype/fixtures.ts';
      import {writeCyclesConstruction} from './src/render/prototype/cycles/compile.ts';
      import {parseDesign} from './src/domain/design.ts';
      const output = process.argv[1];
      for (const f of createPrototypeFixtures())
        writeCyclesConstruction(f.design, output+'/'+f.id);
      const d = createPrototypeFixtures()[0].design;
      writeCyclesConstruction(parseDesign({...d, presentation:{...d.presentation, aspect:'tall'}}), output+'/portrait');
    """
    subprocess.run(
        [
            "node",
            "--import",
            "./src/render/prototype/register.ts",
            "--input-type=module",
            "-e",
            script,
            str(output),
        ],
        cwd=ROOT,
        env={"PATH": os.environ["PATH"], "HOME": str(output)},
        check=True,
        capture_output=True,
        timeout=90,
    )
    return sorted(output.iterdir())


@pytest.mark.parametrize("case", range(7))
def test_constructs_real_blender_data_without_rendering(packages, case):
    directory = packages[case]
    p = read_package(directory, identity(directory))
    studio, receipt = construct(directory, identity(directory))
    assert receipt["renderCalls"] == 0
    assert receipt["completedSamplesPerPixel"] is None
    assert receipt["qualified"] is False
    assert receipt["renderAllowed"] is False
    assert receipt["objectCount"] == len(p["scene"]["objects"])
    assert receipt["textureCount"] > 0
    assert all(image.packed_file is not None for image, _ in studio.images.values())
    assert receipt["holds"]
    np.testing.assert_allclose(receipt["cameraMatrix"], p["camera"]["matrix"], atol=2e-6)
    # Test the projected vertical field, not just the stored angle_y property.
    frame = studio.camera.data.view_frame(scene=studio.scene)
    angle = 2 * math.atan(abs(frame[0].y / frame[0].z))
    assert math.degrees(angle) == pytest.approx(p["camera"]["fov"], abs=1e-4)
    assert studio.scene.unit_settings.scale_length == pytest.approx(0.3048)
    verify_strict_settings(studio.scene)
    with pytest.raises(RuntimeError, match="rendering remains disabled"):
        studio.render({})


@pytest.mark.parametrize(
    "field,value",
    [
        ("samples", 32),
        ("use_adaptive_sampling", True),
        ("adaptive_threshold", 0.1),
        ("time_limit", 1),
        ("use_sample_subset", True),
        ("use_layer_samples", "USE"),
        ("seed", 1),
        ("denoiser", "OPTIX"),
    ],
)
def test_detects_strict_setting_mutation(field, value):
    import bpy

    scene = bpy.context.scene
    apply_strict_settings(scene)
    setattr(scene.cycles, field, value)
    with pytest.raises(RuntimeError, match="Strict setting changed"):
        verify_strict_settings(scene)
    apply_strict_settings(scene)


def test_rejects_wrong_manifest_identity(packages):
    with pytest.raises(ValueError, match="identity mismatch"):
        read_package(packages[0], "sha256:" + "0" * 64)


@pytest.mark.parametrize(
    "field,value",
    [
        ("adaptiveSampling", True),
        ("nativeTimeLimitSeconds", 1),
        ("requestedSamplesPerPixel", 64),
        ("minimumCompletedSamplesPerPixel", 1),
        ("lowerTierFallbackAllowed", True),
        ("blenderVersion", "4.4.0"),
    ],
)
def test_rejects_non_strict_manifest(packages, tmp_path, field, value):
    p = json.loads((packages[0] / "manifest.json").read_text())
    p["settings"][field] = value
    (tmp_path / "manifest.json").write_text(json.dumps(p))
    with pytest.raises(ValueError, match="Strict setting mismatch"):
        read_package(tmp_path, identity(tmp_path))


@pytest.mark.parametrize("fault", ["missing", "corrupt", "symlink"])
def test_rejects_blob_failures_before_blender(packages, tmp_path, fault):
    import shutil

    shutil.copytree(packages[0], tmp_path, dirs_exist_ok=True)
    p = json.loads((tmp_path / "manifest.json").read_text())
    blob = tmp_path / "blobs" / p["blobs"][0]["hash"]
    blob.unlink()
    if fault == "corrupt":
        blob.write_bytes(b"invalid")
    if fault == "symlink":
        blob.symlink_to(packages[0] / "blobs" / blob.name)
    with pytest.raises(ValueError):
        read_package(tmp_path, identity(tmp_path))
