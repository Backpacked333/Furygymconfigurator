"""Retired entry points cannot import providers, start workers or allocate resources."""

import builtins
import runpy
from pathlib import Path

import pytest


@pytest.mark.parametrize("warm", ["0", "1"])
def test_deployment_stops_before_importing_modal(monkeypatch, warm):
    monkeypatch.setenv("FURY_WARM", warm)
    monkeypatch.setenv("FURY_GPU", "L40S:8")
    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        assert name != "modal", "Deployment must not even import the provider SDK"
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    with pytest.raises(RuntimeError, match="LEGACY_RENDER_DISABLED"):
        runpy.run_path(str(Path(__file__).parents[1] / "modal_app.py"))


def test_raw_scene_cli_stops_before_importing_server_or_workers(monkeypatch):
    from fury_render.local import main

    original = builtins.__import__

    def guarded(name, *args, **kwargs):
        assert name not in ("uvicorn", "bpy", "fury_render.api", "api")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    with pytest.raises(SystemExit, match="LEGACY_RENDER_DISABLED"):
        main()
