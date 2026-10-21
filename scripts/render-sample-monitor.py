"""Best-effort CPU telemetry. Never imports Blender or signals a render process."""

import argparse
import datetime as dt
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import shlex
import stat
import ssl
import time
import urllib.request

ROOTS = (Path("/var/tmp/fury-10001"), Path("/var/tmp/fury-10002"))
CAMERAS = {
    "front-left-draft@1", "front-draft@1", "left-draft@1",
    "rear-left-draft@1", "entry-draft@1",
}
SAMPLE = re.compile(rb"\bSample\s+(\d{1,4})\s*/\s*1024\b")
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
IMAGE = re.compile(r"img_[a-f0-9]{64}")


def bounded(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        value = source.read(limit + 1)
    if len(value) > limit:
        raise ValueError("telemetry-file-cap")
    return value


def observe(proc_root=Path("/proc"), roots=ROOTS):
    observations = []
    for proc in proc_root.iterdir():
        if not proc.name.isdigit():
            continue
        try:
            command = bounded(proc / "cmdline", 4096)
            args = command.rstrip(b"\0").split(b"\0")
            if len(args) != 5 or args[1:3] != [b"-m", b"on_demand.renderer"]:
                continue
            root = Path(os.fsdecode(args[3])).resolve(strict=True)
            if root.parent not in roots or not root.name.startswith("native-"):
                continue
            image_key = args[4].decode("ascii")
            if not IMAGE.fullmatch(image_key):
                continue
            # Cold render children have one immutable image argument. Skip batch/warm children.
            started = bounded(proc / "stat", 4096)
            job = json.loads(bounded(root / "job.json", 64 * 1024))
            claim = job["claim"]
            if any(not UUID.fullmatch(claim[k]) for k in ("jobId", "attemptId")):
                continue
            if type(claim["fence"]) is not int or claim["fence"] < 1:
                continue
            view = next(v for v in job["views"] if v["imageKey"] == image_key)
            if view["cameraRef"] not in CAMERAS:
                continue
            fd = os.open(root / "blender.log", os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as source:
                source.seek(max(0, os.fstat(source.fileno()).st_size - 16 * 1024))
                matches = list(SAMPLE.finditer(source.read(16 * 1024)))
            if not matches:
                continue
            completed = int(matches[-1][1])
            if completed > 1024:
                continue
            # Reject exit/PID reuse and a next-view log created during the read.
            if bounded(proc / "cmdline", 4096) != command:
                continue
            after = bounded(proc / "stat", 4096)
            if started.rsplit(b") ", 1)[1].split()[19] != after.rsplit(b") ", 1)[1].split()[19]:
                continue
            observations.append({
                "jobId": claim["jobId"], "attemptId": claim["attemptId"],
                "fence": claim["fence"], "cameraRef": view["cameraRef"],
                "imageKey": image_key, "completed": completed, "total": 1024,
                "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            })
        except (OSError, ValueError, KeyError, TypeError, StopIteration, IndexError):
            continue
    return observations[:2]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


@lru_cache(maxsize=1)
def publisher_opener():
    return urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )


def publish(observations):
    origin = os.environ["SUPABASE_URL"].rstrip("/")
    if not re.fullmatch(r"https://[a-z0-9-]+\.supabase\.co", origin):
        raise ValueError("invalid-telemetry-origin")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    opener = publisher_opener()
    for observation in observations:
        request = urllib.request.Request(
            origin + "/rest/v1/rpc/render_library_record_samples",
            data=json.dumps({"observation": observation}).encode(),
            headers={"Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key},
            method="POST",
        )
        with opener.open(request, timeout=2) as response:
            response.read(1024)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--env-file", type=Path)
    options = parser.parse_args()
    if options.env_file:
        info = options.env_file.stat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
            raise ValueError("telemetry-env-must-be-owner-only")
        for line in bounded(options.env_file, 64 * 1024).decode().splitlines():
            for pair in shlex.split(line, comments=True):
                key, separator, value = pair.partition("=")
                if separator and key in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
                    os.environ[key] = value
    while True:
        start = time.monotonic()
        observations = observe()
        if options.once:
            print(json.dumps(observations))
            return
        if options.output:
            temporary = options.output.with_suffix(".tmp")
            temporary.write_text(json.dumps(observations))
            temporary.chmod(0o600)
            temporary.replace(options.output)
        if options.publish:
            try:
                publish(observations)
            except Exception:
                # Optional telemetry must never retry, queue work, or affect the render journal.
                pass
        time.sleep(max(0.1, 2 - (time.monotonic() - start)))


if __name__ == "__main__":
    main()
