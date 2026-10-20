"""Run the warm-worker runtime locally on the Vast host; the dispatcher shares the GPU box."""

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from on_demand.dispatcher import Provider, atomic_json

ACTIONS = ("create", "find", "send", "logs", "poll", "terminate", "release")
MAX_PACKAGE_BYTES = 600 * 1024 * 1024


class LocalVastProvider(Provider):
    def command(self, action, control):
        path = self.work / "vast-control.json"
        atomic_json(path, control)
        return [sys.executable, "-m", "vast_host", action, str(path)]


def runtime_command(action, control):
    instance = os.environ["FURY_VAST_INSTANCE"]
    if not instance.isdigit() or int(instance) <= 0:
        raise ValueError("invalid-instance")
    build = control["workerBuildSha256"]
    if not re.fullmatch(r"[a-f0-9]{64}", build):
        raise ValueError("invalid-build")
    if action not in ACTIONS:
        raise ValueError("unknown-action")
    payload = {key: control[key] for key in ("name", "timeout", "workerBuildSha256")}
    payload["instanceId"] = instance
    if "id" in control:
        payload["id"] = control["id"]
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin",
           "PYTHONPATH": f"/opt/fury/releases/{build}/render-server"}
    return ["/usr/local/bin/python", "-m", "on_demand.vast_runtime", action, encoded], env


def main(action, path):
    control = json.loads(Path(path).read_text())
    command, env = runtime_command(action, control)
    if action != "send":
        subprocess.run(command, env=env, stdin=subprocess.DEVNULL, check=True,
                       stdout=sys.stdout, stderr=subprocess.DEVNULL)
        return
    package = Path(control["package"])
    size = package.stat().st_size
    if not 0 < size <= MAX_PACKAGE_BYTES:
        raise ValueError("package-cap")
    proc = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=sys.stdout,
                            stderr=subprocess.DEVNULL)
    try:
        proc.stdin.write((json.dumps({"bytes": size}) + "\n").encode())
        sent = 0
        with package.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                sent += len(chunk)
                if sent > size:
                    raise ValueError("package-changed")
                proc.stdin.write(chunk)
        if sent != size:
            raise ValueError("package-changed")
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("transfer-failed")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except Exception:
        print('{"error":"vast-local-control-failed"}', file=sys.stderr)
        sys.exit(1)
