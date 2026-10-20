"""Provision a verified source release on an already-rented host. Never manages rentals."""

import argparse
import ctypes
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys


def verify_interpreter():
    pinned = Path("/usr/local/bin/python")
    if not pinned.is_file() or not os.access(pinned, os.X_OK) or pinned.resolve() != Path(sys.executable).resolve():
        raise RuntimeError("pinned-python-required")


def setup(root, instance):
    if os.getuid() != 0 or instance <= 0:
        raise RuntimeError("root-and-instance-required")
    verify_interpreter()
    manifest = json.loads((root / "native-build.json").read_text())
    recipe = manifest["recipe"]
    canonical = json.dumps(manifest["files"], sort_keys=True, separators=(",", ":")).encode()
    if (hashlib.sha256(canonical).hexdigest() != recipe["workerBuildSha256"] or
            json.loads((root / "recipe.json").read_text()) != recipe or
            recipe.get("gpuDevice") != "NVIDIA GeForce RTX 5090" or
            root != Path("/opt/fury/releases") / recipe["workerBuildSha256"]):
        raise RuntimeError("immutable-release-mismatch")
    for name, checksum in manifest["files"].items():
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise RuntimeError("source-verification-failed")
    hardware = subprocess.check_output(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], text=True).strip()
    if hardware != recipe["gpuDevice"]:
        raise RuntimeError("wrong-GPU")
    ctypes.CDLL("libseccomp.so.2")
    for path in [root, *root.rglob("*")]:
        if path.is_symlink():
            raise RuntimeError("source-symlink")
        os.chown(path, 0, 0)
        path.chmod(0o755 if path.is_dir() else 0o644)
    for uid in (10001, 10002):
        name = f"fury-slot-{uid - 10000}"
        try:
            if not grp.getgrgid(uid).gr_name.startswith("fury"):
                raise RuntimeError("slot-group-collision")
        except KeyError:
            subprocess.run(["groupadd", "--gid", str(uid), name], check=True)
        try:
            if not pwd.getpwuid(uid).pw_name.startswith("fury"):
                raise RuntimeError("slot-user-collision")
        except KeyError:
            subprocess.run(["useradd", "--uid", str(uid), "--gid", str(uid), "--no-create-home",
                            "--shell", "/usr/sbin/nologin", name], check=True)
        home = Path(f"/var/tmp/fury-{uid}")
        home.mkdir(mode=0o700, exist_ok=True)
        os.chown(home, uid, uid)
        home.chmod(0o700)
    state = Path("/var/lib/fury")
    state.mkdir(mode=0o700, exist_ok=True)
    (state / "jobs").mkdir(mode=0o700, exist_ok=True)
    config = state / "worker.json"
    if config.exists():
        if json.loads(config.read_text()) != {"instanceId": instance}:
            raise RuntimeError("worker-instance-mismatch")
    else:
        with config.open("x") as stream:
            json.dump({"instanceId": instance}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        config.chmod(0o600)
    print(json.dumps({"installedBuild": recipe["workerBuildSha256"], "instanceId": instance,
                      "device": hardware, "slots": 2, "rentalAction": "none"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("release", type=Path)
    parser.add_argument("instance", type=int)
    args = parser.parse_args()
    setup(args.release.resolve(), args.instance)
