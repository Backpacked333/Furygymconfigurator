"""Denoiser choice and its fallbacks (no GPU needed: the settings are what is checked)."""

from __future__ import annotations

import ast
import os
import subprocess
import sys

import pytest

from fury_render.api import Settings, Worker, WorkerDied
from fury_render.worker import warm_with_fallback

CHECK = """
import bpy
from fury_render.blender import configure_denoiser

scene = bpy.context.scene
c = scene.cycles
results = [configure_denoiser(scene, "OPTIX")]
results.append((c.denoiser, c.use_denoising, c.denoising_use_gpu, c.denoising_prefilter))
for device, mode in (("OPTIX", "cpu"), ("CPU", "auto")):
    results.append(configure_denoiser(scene, device, mode))
    results.append((c.denoising_use_gpu, c.denoising_prefilter))
print(repr(results))
"""


def test_denoises_on_the_gpu_when_rendering_on_one():
    # bpy changes sys.path on import, which would leak into the renderer processes other tests
    # spawn, so it is checked in a process of its own.
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run(
        [sys.executable, "-c", CHECK], cwd=root, capture_output=True, text=True, check=True
    ).stdout
    results = ast.literal_eval(out.strip().splitlines()[-1])
    assert results[0] == "gpu"
    assert results[1] == ("OPENIMAGEDENOISE", True, True, "ACCURATE")
    # Forced to the CPU, or on a CPU device: the fast prefilter keeps it to a third of the work.
    assert results[2:] == ["cpu", (False, "FAST"), "cpu", (False, "FAST")]


class FakeStudio:
    def __init__(self, denoise):
        self.denoise = denoise

    def set_denoise(self, mode):
        self.denoise = mode


def test_warm_up_falls_back_to_cpu_denoising():
    studio = FakeStudio("gpu")
    calls = []

    def warm():
        calls.append(studio.denoise)
        if studio.denoise == "gpu":
            raise RuntimeError("denoiser failed to start")

    warm_with_fallback(studio, warm)
    assert calls == ["gpu", "cpu"] and studio.denoise == "cpu"


def test_warm_up_failures_without_gpu_denoising_still_raise():
    def warm():
        raise RuntimeError("no device")

    with pytest.raises(RuntimeError):
        warm_with_fallback(FakeStudio("cpu"), warm)


def test_worker_restarts_with_cpu_denoising(monkeypatch, tmp_path):
    worker = Worker(Settings(device="auto", blob_dir=str(tmp_path), denoise="auto"))
    attempts = []

    def spawn():
        attempts.append(worker.denoise)
        if worker.denoise != "cpu":
            raise WorkerDied("crashed while denoising")
        return {"ready": True, "denoise": "cpu"}

    monkeypatch.setattr(worker, "_spawn", spawn)
    assert worker.start()["denoise"] == "cpu"
    assert attempts == ["auto", "cpu"]
    # A worker that later dies while denoising on the GPU comes back on the CPU.
    worker = Worker(Settings(device="auto", blob_dir=str(tmp_path)))
    worker.info = {"denoise": "gpu"}
    worker.crashed()
    assert worker.denoise == "cpu"
