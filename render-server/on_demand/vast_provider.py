"""SSH control for an operator-provisioned warm worker; never rents or destroys a GPU."""

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from .dispatcher import Provider, atomic_json


class VastProvider(Provider):
    def command(self, action, control):
        path = self.work / "vast-control.json"
        atomic_json(path, control)
        return [sys.executable, "-m", "on_demand.vast_provider", action, str(path)]


def ssh_command(action, control, directory):
    host, port = os.environ["FURY_VAST_HOST"], os.environ["FURY_VAST_PORT"]
    instance = os.environ["FURY_VAST_INSTANCE"]
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", host) or not port.isdigit() or not 0 < int(port) < 65536:
        raise ValueError("invalid-SSH-endpoint")
    if not instance.isdigit() or int(instance) <= 0:
        raise ValueError("invalid-instance")
    build = control["workerBuildSha256"]
    if not re.fullmatch(r"[a-f0-9]{64}", build):
        raise ValueError("invalid-build")
    for name, value in (("key", os.environ["FURY_VAST_SSH_KEY"]),
                        ("known_hosts", os.environ["FURY_VAST_KNOWN_HOSTS"])):
        path = directory / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(value.rstrip() + "\n")
    payload = {key: control[key] for key in ("name", "timeout", "workerBuildSha256")}
    payload["instanceId"] = instance
    if "id" in control:
        payload["id"] = control["id"]
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    if action not in ("create", "find", "send", "logs", "poll", "terminate", "release"):
        raise ValueError("unknown-action")
    return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
            "-o", f"UserKnownHostsFile={directory / 'known_hosts'}", "-i", str(directory / "key"),
            "-p", port, "root@" + host,
            f"PYTHONPATH=/opt/fury/releases/{build}/render-server /usr/local/bin/python -m "
            f"on_demand.vast_runtime {action} {encoded}"]


def main(action, path):
    import tempfile
    control = json.loads(Path(path).read_text())
    with tempfile.TemporaryDirectory(prefix="vast-ssh-") as temporary:
        command = ssh_command(action, control, Path(temporary))
        if action == "send":
            package = Path(control["package"])
            size = package.stat().st_size
            if not 0 < size <= 600 * 1024 * 1024:
                raise ValueError("package-cap")
            proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=sys.stdout,
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
        else:
            subprocess.run(command, stdin=subprocess.DEVNULL, check=True,
                           stdout=sys.stdout, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except Exception:
        print('{"error":"vast-control-failed"}', file=sys.stderr)
        sys.exit(1)
