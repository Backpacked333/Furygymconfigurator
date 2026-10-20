"""Bounded credential-free supervisor. Stdin package; structured stdout; no network."""

import base64
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

from .validation import (
    CHUNK_BYTES,
    timestamp,
    validate_claim,
    verify_receipt,
    verify_webp,
)


def frame(value):
    line = json.dumps(value, separators=(",", ":"))
    if len(line) > 24576:
        raise RuntimeError("frame-cap")
    print(line, flush=True)


def clean_env():
    result = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
    }
    for key in (
        "CUDA_VISIBLE_DEVICES",
        "NVIDIA_VISIBLE_DEVICES",
        "NVIDIA_DRIVER_CAPABILITIES",
        "LD_LIBRARY_PATH",
    ):
        if key in os.environ:
            result[key] = os.environ[key]
    return result


def child_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (20 * 1024 * 1024, 20 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def extract(stream, root, length):
    if not 0 < length <= 600 * 1024 * 1024:
        raise RuntimeError("package-cap")
    package = root / "package.tar"
    remaining = length
    with package.open("xb") as target:
        while remaining:
            chunk = stream.read(min(CHUNK_BYTES, remaining))
            if not chunk:
                raise RuntimeError("truncated-package")
            target.write(chunk)
            remaining -= len(chunk)
    total, count = 0, 0
    with tarfile.open(package, mode="r:") as archive:
        for member in archive:
            name = member.name
            allowed = (
                name == "job.json"
                or re.fullmatch(r"img_[a-f0-9]{64}\.json", name)
                or re.fullmatch(r"blobs/[a-f0-9]{64}", name)
            )
            total += member.size
            count += 1
            if not allowed or not member.isfile() or total > 550 * 1024 * 1024 or count > 50000:
                raise RuntimeError("invalid-package-member")
            target = root / name
            target.parent.mkdir(exist_ok=True)
            with target.open("xb") as output, archive.extractfile(member) as source:
                while chunk := source.read(CHUNK_BYTES):
                    output.write(chunk)
    package.unlink()


def run(root):
    job = json.loads((root / "job.json").read_text())
    recipe = json.loads((Path(__file__).resolve().parents[2] / "recipe.json").read_text())
    claim = validate_claim(job["claim"], recipe)
    if {v["imageKey"] for v in job["views"]} != {v["imageKey"] for v in claim["views"]} or len(
        job["views"]
    ) != len(claim["views"]):
        raise RuntimeError("prepared-view-set")
    for view in job["views"]:
        budget = min(
            claim["limits"]["imageSeconds"],
            timestamp(claim["deadlineAt"]) - time.time(),
        )
        if budget <= 0:
            raise RuntimeError("deadline")
        frame({"kind": "progress", "stage": "rendering", "cameraRef": view["cameraRef"]})
        proc = None
        log = root / "blender.log"
        try:
            with log.open("wb") as output:
                proc = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "on_demand.renderer",
                        str(root),
                        view["imageKey"],
                    ],
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    env=clean_env(),
                    start_new_session=True,
                    preexec_fn=child_limits,
                )
                proc.wait(timeout=budget)
            if proc.returncode != 0:
                raise RuntimeError("native-render-failed")
            # Completion callback plus Cycles' final sample log; never infer samples from a timer.
            with log.open("rb") as source:
                source.seek(max(0, log.stat().st_size - 4 * 1024 * 1024))
                completed_samples = bool(
                    re.search(rb"Sample\s+1024\s*/\s*1024", source.read(4 * 1024 * 1024))
                )
            if not completed_samples:
                raise RuntimeError("completed-samples-unproven")
            receipt = json.loads((root / "receipt.json").read_text())
            verify_receipt(receipt, claim, view, recipe.get("gpuDevice", "NVIDIA L40S"))
            verify_webp(root / "image.webp", receipt)
            frame({"kind": "progress", "stage": "saving", "cameraRef": view["cameraRef"]})
            frame({"kind": "artifact-start", "receipt": receipt})
            with (root / "image.webp").open("rb") as source:
                while chunk := source.read(CHUNK_BYTES):
                    frame(
                        {
                            "kind": "artifact-chunk",
                            "data": base64.b64encode(chunk).decode(),
                        }
                    )
            frame({"kind": "artifact-end", "sha256": receipt["sha256"]})
            for name in ("receipt.json", "image.webp", "blender.log"):
                (root / name).unlink(missing_ok=True)
        finally:
            if proc:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
    frame({"kind": "done", "outcome": "complete"})


def ensure_non_root():
    if os.getuid() == 0:
        os.setgroups([])
        uid = int(os.environ.get("FURY_RENDER_UID", "10001"))
        if uid not in (10001, 10002):
            raise RuntimeError("invalid-render-uid")
        os.setgid(uid)
        os.setuid(uid)
    if os.getuid() == 0:
        raise RuntimeError("non-root-Sandbox-required")


def main():
    ensure_non_root()
    if os.environ.get("FURY_BLOCK_NETWORK") == "1":
        from .network_policy import block_internet
        block_internet()

    def timeout(*_):
        raise TimeoutError("startup-deadline")

    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(180)
    with tempfile.TemporaryDirectory(prefix="native-") as directory:
        root = Path(directory)
        header = sys.stdin.buffer.readline(512)
        info = json.loads(header)
        extract(sys.stdin.buffer, root, info["bytes"])
        signal.alarm(0)
        run(root)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        frame({"kind": "done", "outcome": "failed"})
        sys.exit(1)
