"""Two bounded, isolated-UID render slots on a retained Vast GPU. No cloud credentials."""

import base64
import fcntl
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import time

from .dispatcher import atomic_json

ROOT = Path(__file__).resolve().parents[2]
STATE = Path("/var/lib/fury/jobs")
MAX_BYTES = 600 * 1024 * 1024


def process_identity(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def kill_slot(uid):
    if uid not in (10001, 10002):
        raise ValueError("invalid-slot")
    for _ in range(100):
        live = False
        for path in Path("/proc").iterdir():
            if path.name.isdigit():
                try:
                    if path.stat().st_uid == uid and path.joinpath("stat").read_text().rsplit(")", 1)[1].split()[0] != "Z":
                        live = True
                        os.kill(int(path.name), signal.SIGKILL)
                except (ProcessLookupError, FileNotFoundError):
                    pass
        if not live:
            return
        time.sleep(.02)
    raise RuntimeError("slot-termination-unconfirmed")


class Runtime:
    def __init__(self, control, state=STATE, root=ROOT):
        self.control, self.state, self.root = control, state, root
        name = control["name"]
        if not re.fullmatch(r"fury-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", name):
            raise ValueError("invalid-job-name")
        config = json.loads((state.parent / "worker.json").read_text())
        recipe = json.loads((root / "recipe.json").read_text())
        if (str(config["instanceId"]) != control["instanceId"] or
                recipe["workerBuildSha256"] != control["workerBuildSha256"] or
                recipe.get("gpuDevice") != "NVIDIA GeForce RTX 5090"):
            raise ValueError("worker-binding")
        if type(control["timeout"]) is not int or not 0 < control["timeout"] <= 2100:
            raise ValueError("timeout")
        self.id = f"vast:{control['instanceId']}:{name}"
        if control.get("id", self.id) != self.id:
            raise ValueError("provider-binding")
        self.directory = state / name

    def read(self):
        value = json.loads((self.directory / "state.json").read_text())
        if value["id"] != self.id or value["workerBuildSha256"] != self.control["workerBuildSha256"]:
            raise ValueError("job-binding")
        return value

    def save(self, value):
        atomic_json(self.directory / "state.json", value)

    def create(self):
        with (self.state / "lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.directory.exists():
                self.read()
                return {"id": self.id}
            occupied = set()
            for path in self.state.glob("fury-*/state.json"):
                row = json.loads(path.read_text())
                if row.get("exitCode") is None:
                    occupied.add(row["uid"])
            available = {10001, 10002} - occupied
            if not available:
                raise RuntimeError("worker-busy")
            self.directory.mkdir(mode=0o700)
            now = time.time()
            self.save({"id": self.id, "workerBuildSha256": self.control["workerBuildSha256"],
                       "uid": min(available), "createdAt": now, "deadline": now + self.control["timeout"],
                       "exitCode": None, "pid": None})
            encoded = base64.urlsafe_b64encode(json.dumps(self.control).encode()).decode()
            proc = subprocess.Popen([sys.executable, "-m", "on_demand.vast_runtime", "supervise", encoded],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, start_new_session=True,
                                    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": str(self.root / "render-server")},
                                    cwd=self.root)
            row = self.read()
            row.update(pid=proc.pid, processIdentity=process_identity(proc.pid))
            self.save(row)
            return {"id": self.id}

    def send(self, source):
        row = self.read()
        if row["exitCode"] is not None or time.time() >= min(row["deadline"], row["createdAt"] + 180):
            raise ValueError("input-deadline")
        header = source.readline(512)
        info = json.loads(header)
        size = info["bytes"]
        if type(size) is not int or not 0 < size <= MAX_BYTES:
            raise ValueError("package-cap")
        with (self.directory / "input-started").open("x"):
            pass
        partial = self.directory / "input.partial"
        with partial.open("xb") as output:
            output.write(header)
            remaining = size
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError("truncated-input")
                output.write(chunk)
                remaining -= len(chunk)
            output.flush()
            os.fsync(output.fileno())
        partial.replace(self.directory / "input.stream")
        return {"sent": True, "bytes": size}

    def find(self):
        with (self.state / "lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not self.directory.exists():
                self.directory.mkdir(mode=0o700)
                now = time.time()
                # Fences a delayed create as well as proving no process was launched.
                self.save({"id": self.id, "workerBuildSha256": self.control["workerBuildSha256"],
                           "uid": None, "createdAt": now, "deadline": now,
                           "exitCode": 1, "pid": None, "finishedAt": now})
            return {"id": self.read()["id"]}

    def supervise(self):
        # Creation holds this lock until its durable PID identity has been written.
        with (self.state / "lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
        row = self.read()
        proc, code = None, 1

        def expired(*_):
            raise TimeoutError("job-deadline")

        signal.signal(signal.SIGTERM, expired)
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(max(1, int(row["deadline"] - time.time())))
        try:
            source = self.directory / "input.stream"
            while not source.exists():
                if time.time() >= row["createdAt"] + 180:
                    raise TimeoutError("input-deadline")
                time.sleep(.2)
            home = f"/var/tmp/fury-{row['uid']}"
            env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": home, "TMPDIR": home,
                   "PYTHONPATH": str(self.root / "render-server"), "FURY_RENDER_UID": str(row["uid"]),
                   "FURY_BLOCK_NETWORK": "1",
                   "LD_LIBRARY_PATH": "/opt/nvidia-optix:/usr/local/nvidia/lib:/usr/local/nvidia/lib64"}

            def limits():
                resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

            with source.open("rb") as data, (self.directory / "frames.log").open("wb") as log:
                proc = subprocess.Popen([sys.executable, "-m", "on_demand.sandbox_runner"], stdin=data,
                                        stdout=log, stderr=subprocess.DEVNULL, env=env, cwd=self.root,
                                        start_new_session=True, preexec_fn=limits)
                code = proc.wait(timeout=max(1, row["deadline"] - time.time()))
        except BaseException:
            code = 1
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            if proc:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
            kill_slot(row["uid"])
            row.update(exitCode=code, finishedAt=time.time())
            self.save(row)

    def poll(self):
        row = self.read()
        if row["exitCode"] is None and (not row["pid"] or process_identity(row["pid"]) != row.get("processIdentity")):
            # A lost supervisor cannot turn into a second render or release a live slot.
            with (self.state / "lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                row = self.read()
                if row["exitCode"] is None and (not row["pid"] or process_identity(row["pid"]) != row.get("processIdentity")):
                    kill_slot(row["uid"])
                    row.update(exitCode=1, finishedAt=time.time())
                    self.save(row)
        return {"exitCode": row["exitCode"]}

    def terminate(self):
        row = self.read()
        if row["exitCode"] is None and row["pid"] and process_identity(row["pid"]) == row.get("processIdentity"):
            os.kill(row["pid"], signal.SIGTERM)
        self.poll()
        return {"requested": True}

    def logs(self):
        offset = 0
        path = self.directory / "frames.log"
        while True:
            terminal = self.poll()["exitCode"] is not None
            if path.exists():
                with path.open("rb") as stream:
                    stream.seek(offset)
                    while chunk := stream.read(16384):
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                        offset += len(chunk)
            if terminal:
                return
            time.sleep(.2)

    def release(self):
        if self.poll()["exitCode"] is None:
            raise ValueError("job-still-running")
        for name in ("input.stream", "input.partial"):
            (self.directory / name).unlink(missing_ok=True)
        return {"released": True}


def main(action, encoded):
    if os.getuid() != 0 or len(encoded) > 8192:
        raise ValueError("private-supervisor-required")
    runtime = Runtime(json.loads(base64.urlsafe_b64decode(encoded)))
    if action == "send":
        result = runtime.send(sys.stdin.buffer)
    elif action in ("create", "find", "poll", "terminate", "release", "logs", "supervise"):
        result = getattr(runtime, action)()
    else:
        raise ValueError("unknown-action")
    if result is not None:
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except Exception:
        print('{"error":"warm-worker-failed"}', file=sys.stderr)
        sys.exit(1)
