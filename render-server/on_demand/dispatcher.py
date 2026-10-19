"""Dedicated CPU daemon; claims admitted outbox work automatically, never re-creates a Sandbox."""

import argparse
import base64
import fcntl
import json
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tarfile
import time
import uuid

from .journal import Journal
from .transport import Service
from .validation import (
    CONTRACT,
    CHUNK_BYTES,
    MAX_IMAGE_BYTES,
    digest,
    canonical,
    iso_now,
    timestamp,
    validate_claim,
    verify_receipt,
    verify_webp,
)

ERRORS = {
    "worker-failed": "Rendering stopped. Completed images remain available.",
    "provider-unavailable": "The rendering service is currently unavailable.",
    "dispatch-uncertain": "We are checking whether rendering started. Please do not submit again.",
}


def error(code):
    return {"code": code, "message": ERRORS[code], "retryable": False}


def atomic_json(path, value):
    temp = path.with_suffix(".tmp")
    with temp.open("w") as stream:
        json.dump(value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def kill_tree(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


class Provider:
    def __init__(self, root, work):
        self.root, self.work = root, work

    def command(self, action, control):
        path = self.work / "provider-control.json"
        atomic_json(path, control)
        return [sys.executable, "-m", "on_demand.provider", action, str(path)]

    def call(self, action, control, timeout=45):
        proc = subprocess.Popen(
            self.command(action, control),
            cwd=self.root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            output, _ = proc.communicate(timeout=timeout)
            if proc.returncode or len(output) > 16384:
                raise RuntimeError("provider-call-failed")
            return json.loads(output)
        finally:
            kill_tree(proc)

    def logs(self, control, timeout):
        proc = subprocess.Popen(
            self.command("logs", control),
            cwd=self.root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        buffer = b""
        total = 0
        deadline = time.monotonic() + timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError("provider-log-deadline")
                chunk = os.read(proc.stdout.fileno(), 16384)
                if not chunk:
                    break
                total += len(chunk)
                buffer += chunk
                if total > 64 * 1024 * 1024:
                    raise RuntimeError("log-cap")
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if len(line) > 24576:
                        raise RuntimeError("frame-cap")
                    yield json.loads(line)
                if len(buffer) > 24576:
                    raise RuntimeError("frame-cap")
            if buffer or proc.wait(timeout=5):
                raise RuntimeError("incomplete-log-stream")
        finally:
            selector.close()
            kill_tree(proc)


class Dispatcher:
    def __init__(self, service, provider, journal, policy, root, work, prepare=None):
        self.service, self.provider, self.journal = service, provider, journal
        self.policy, self.root, self.work = policy, Path(root), Path(work)
        self.prepare = prepare or self.prepare_cpu

    def active(self):
        p = self.policy
        if (
            p.get("enabled") is not True
            or not p.get("approvalId")
            or timestamp(p["expiresAt"]) <= time.time()
        ):
            raise RuntimeError("operator-approval-required")
        if not 0 < p["maxJobLiabilityMicroUsd"] <= p["globalBudgetMicroUsd"]:
            raise RuntimeError("budget-required")

    def verify_source(self):
        manifest = json.loads((self.root / "native-build.json").read_text())
        if (
            manifest["recipe"] != self.policy["recipe"]
            or digest(canonical(manifest["files"]).encode())
            != manifest["recipe"]["workerBuildSha256"]
        ):
            raise RuntimeError("package-recipe-mismatch")
        for name, checksum in manifest["files"].items():
            path = self.root / name
            if (
                path.is_absolute()
                and not path.resolve().is_relative_to(self.root)
                or path.is_symlink()
                or not path.is_file()
                or digest(path.read_bytes()) != checksum
            ):
                raise RuntimeError("source-package-drift")

    def prepare_cpu(self, row, directory):
        self.verify_source()
        atomic_json(directory / "claim.json", row["claim"])
        atomic_json(directory / "recipe.json", self.policy["recipe"])
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(directory),
            "NODE_NO_WARNINGS": "1",
        }
        command = [
            "node",
            "--import",
            "./scripts/native-render-register.mjs",
            "scripts/native-render-prepare.ts",
            str(directory / "claim.json"),
            str(directory / "recipe.json"),
            str(directory / "scene"),
        ]
        proc = subprocess.Popen(
            command,
            cwd=self.root,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            proc.wait(
                timeout=min(
                    row["claim"]["limits"]["preparationSeconds"],
                    max(1, timestamp(row["claim"]["deadlineAt"]) - time.time()),
                )
            )
            if proc.returncode:
                raise RuntimeError("trusted-preparation-failed")
        finally:
            kill_tree(proc)
        package = directory / "input.tar"
        with tarfile.open(package, "x", format=tarfile.USTAR_FORMAT) as archive:
            for path in sorted((directory / "scene").rglob("*")):
                if path.is_symlink():
                    raise RuntimeError("package-symlink")
                if path.is_file():
                    archive.add(
                        path,
                        arcname=str(path.relative_to(directory / "scene")),
                        recursive=False,
                    )
        return package

    def record_dispatch(self, row):
        self.service.rpc(
            "record_dispatch",
            {
                "dispatchId": row["dispatch"]["dispatchId"],
                "claimToken": row["claimToken"],
                "result": row["result"],
            },
        )

    def new_job(self):
        self.active()
        dispatch = self.service.rpc(
            "claim_dispatch", {"dispatcherId": self.policy["dispatcherId"]}
        )
        if dispatch is None:
            return None
        row = {
            **dispatch,
            "phase": "claimed",
            "claim": None,
            "result": None,
            "provider": None,
            "liabilityMicroUsd": self.policy["maxJobLiabilityMicroUsd"],
        }
        self.journal.save(row)
        # Claim once. An ambiguous claim is NOT retried. No GPU exists on these paths.
        try:
            claim = self.service.claim(
                row["dispatch"], self.policy["recipe"]["workerBuildSha256"]
            )
            if claim is None:
                raise RuntimeError("worker-claim-unavailable")
            row["claim"] = validate_claim(claim, self.policy["recipe"])
            if any(
                claim[k] != row["dispatch"][k]
                for k in ("contractVersion", "jobId", "dispatchId")
            ):
                raise RuntimeError("dispatch-binding")
            self.journal.save(row)
            directory = self.work / row["dispatch"]["dispatchId"]
            directory.mkdir(mode=0o700)
            row["directory"] = str(directory)
            package = self.prepare(row, directory)
            row["package"] = str(package)
            row["prepared"] = json.loads((directory / "scene" / "job.json").read_text())
            self.active()
            lifetime = math.floor(
                min(
                    claim["limits"]["jobSeconds"],
                    timestamp(claim["deadlineAt"]) - time.time(),
                    timestamp(self.policy["expiresAt"]) - time.time(),
                )
            )
            if lifetime <= claim["limits"]["startupSeconds"]:
                raise RuntimeError("insufficient-deadline")
            row["control"] = {
                "appName": self.policy["appName"],
                "imageId": self.policy["imageId"],
                "name": "fury-" + row["dispatch"]["dispatchId"],
                "timeout": lifetime,
                "package": str(package),
            }
        except Exception:
            row["phase"] = "never-submitted"
            row["result"] = {
                "status": "definitely-not-submitted",
                "reason": error("worker-failed"),
            }
            self.journal.save(row)
            return row
        # This durable barrier precedes the only creation call. Recovery never enters creation.
        row["phase"] = "creating"
        self.journal.save(row)
        try:
            provider = self.provider.call(
                "create", row["control"], timeout=claim["limits"]["startupSeconds"]
            )
            if not provider.get("id", "").startswith("sb-"):
                raise RuntimeError("provider-id")
            row["provider"] = provider["id"]
            row["control"]["id"] = provider["id"]
            row["result"] = {"status": "accepted", "providerCallId": provider["id"]}
            row["phase"] = "accepted"
            self.journal.save(row)
            self.record_dispatch(row)
            # Input is single-send too: a restart never resends an ambiguous transfer.
            row["phase"] = "input-started"
            self.journal.save(row)
            self.provider.call(
                "send", row["control"], timeout=claim["limits"]["startupSeconds"]
            )
            row["phase"] = "running"
            self.journal.save(row)
        except Exception:
            if row["provider"] is None:
                row["phase"] = "uncertain"
                row["result"] = {
                    "status": "uncertain",
                    "reason": error("dispatch-uncertain"),
                }
            self.journal.save(row)
        return row

    def flush(self, row):
        for event, artifact in self.journal.pending(row["dispatch"]["dispatchId"]):
            if artifact:
                verify_webp(artifact, event["receipt"])
                self.service.upload(event, artifact)
            if self.service.event(event).get("accepted") is not True:
                raise RuntimeError("event-not-accepted")
            self.journal.delivered(event["eventId"])

    def event(self, row, sequence, kind, **values):
        claim = row["claim"]
        event = {
            k: claim[k] for k in ("contractVersion", "jobId", "attemptId", "fence")
        }
        event.update(
            eventId=str(uuid.uuid5(uuid.UUID(claim["attemptId"]), str(sequence))),
            sequence=sequence,
            kind=kind,
            **values
        )
        return event

    def consume(self, row):
        sequence = 0
        receipt = None
        output = None
        completed = set()
        ended = False
        directory = Path(row["directory"])
        remaining = max(1, timestamp(row["claim"]["deadlineAt"]) - time.time())
        try:
            for frame in self.provider.logs(row["control"], remaining):
                kind = frame.get("kind")
                if ended:
                    raise RuntimeError("frame-after-terminal")
                if kind == "progress":
                    if (
                        receipt
                        or frame["stage"] not in ("rendering", "saving", "verifying")
                        or frame["cameraRef"]
                        not in {v["cameraRef"] for v in row["claim"]["views"]}
                    ):
                        raise RuntimeError("invalid-progress")
                    sequence += 1
                    self.journal.queue(
                        row["dispatch"]["dispatchId"],
                        self.event(
                            row,
                            sequence,
                            "progress",
                            stage=frame["stage"],
                            cameraRef=frame["cameraRef"],
                        ),
                    )
                    self.flush(row)
                elif kind == "artifact-start":
                    if receipt:
                        raise RuntimeError("interleaved-artifact")
                    receipt = frame["receipt"]
                    view = next(
                        v
                        for v in row["prepared"]["views"]
                        if v["imageKey"] == receipt["imageKey"]
                    )
                    verify_receipt(receipt, row["claim"], view)
                    if receipt["imageKey"] in completed:
                        raise RuntimeError("duplicate-artifact")
                    path = directory / (receipt["imageKey"] + ".part")
                    output = path.open("wb")
                    size = 0
                elif kind == "artifact-chunk":
                    if not receipt or not output:
                        raise RuntimeError("chunk-without-artifact")
                    chunk = base64.b64decode(frame["data"], validate=True)
                    size += len(chunk)
                    if len(chunk) > CHUNK_BYTES or size > min(
                        MAX_IMAGE_BYTES, receipt["bytes"]
                    ):
                        raise RuntimeError("chunk-cap")
                    output.write(chunk)
                elif kind == "artifact-end":
                    if (
                        not receipt
                        or not output
                        or frame["sha256"] != receipt["sha256"]
                    ):
                        raise RuntimeError("artifact-end-binding")
                    output.flush()
                    os.fsync(output.fileno())
                    output.close()
                    output = None
                    verify_webp(path, receipt)
                    artifact = directory / (receipt["imageKey"] + ".webp")
                    path.replace(artifact)
                    sequence += 1
                    self.journal.queue(
                        row["dispatch"]["dispatchId"],
                        self.event(row, sequence, "artifact", receipt=receipt),
                        artifact,
                    )
                    completed.add(receipt["imageKey"])
                    receipt = None
                    self.flush(row)
                elif kind == "done":
                    if receipt or frame["outcome"] not in ("complete", "failed"):
                        raise RuntimeError("incomplete-artifact")
                    if frame["outcome"] == "complete" and completed != {
                        v["imageKey"] for v in row["claim"]["views"]
                    }:
                        raise RuntimeError("missing-artifact")
                    ended = True
                    sequence += 1
                    self.journal.queue(
                        row["dispatch"]["dispatchId"],
                        self.event(
                            row,
                            sequence,
                            "terminal",
                            outcome=frame["outcome"],
                            error=(
                                None
                                if frame["outcome"] == "complete"
                                else error("worker-failed")
                            ),
                        ),
                    )
                    self.flush(row)
                    row["logsComplete"] = True
                    self.journal.save(row)
                else:
                    raise RuntimeError("unknown-frame")
        finally:
            if output:
                output.close()

    def recover(self, row):
        if row.get("phase") == "settled":
            return
        if row["phase"] == "claimed":
            row["phase"] = "never-submitted"
            row["result"] = {
                "status": "definitely-not-submitted",
                "reason": error("worker-failed"),
            }
            self.journal.save(row)
        if row["phase"] in ("creating", "uncertain"):
            row["phase"] = "uncertain"
            row["result"] = {
                "status": "uncertain",
                "reason": error("dispatch-uncertain"),
            }
            self.journal.save(row)
            self.record_dispatch(row)
            found = self.provider.call("find", row["control"])
            if not found["id"]:
                return  # Not found is NOT proof of no spend / termination.
            row["provider"] = found["id"]
            row["control"]["id"] = found["id"]
            row["phase"] = "accepted"
            row["result"] = {"status": "accepted", "providerCallId": found["id"]}
            self.journal.save(row)
        self.record_dispatch(row)
        if row["phase"] == "never-submitted":
            evidence = {
                "kind": "never-submitted",
                "dispatchId": row["dispatch"]["dispatchId"],
            }
            charge = 0
        else:
            self.flush(row)
            if not row.get("logsComplete"):
                try:
                    self.consume(row)
                except Exception:
                    pass  # Metadata/artifacts replay later, never re-render.
            # Independent provider poll, never worker-reported terminal or a wall-clock guess.
            observed = self.provider.call("poll", row["control"])
            if observed["exitCode"] is None:
                if time.time() >= timestamp(row["claim"]["deadlineAt"]):
                    self.provider.call("terminate", row["control"])
                return
            if not row.get("logsComplete"):
                # A hard provider stop can leave no worker terminal frame. Keep valid earlier images.
                sequences = [
                    json.loads(payload)["sequence"]
                    for (payload,) in self.journal.db.execute(
                        "SELECT payload FROM deliveries WHERE dispatch_id=?",
                        (row["dispatch"]["dispatchId"],),
                    )
                ]
                sequence = max(sequences, default=0) + 1
                terminal = self.event(
                    row,
                    sequence,
                    "terminal",
                    outcome="failed",
                    error=error("worker-failed"),
                )
                self.journal.queue(row["dispatch"]["dispatchId"], terminal)
                row["logsComplete"] = True
                self.journal.save(row)
            self.flush(row)
            if "evidence" not in row:
                at = iso_now()
                record = {
                    "sandboxId": row["provider"],
                    "exitCode": observed["exitCode"],
                    "observedAt": at,
                }
                row["evidence"] = {
                    "kind": "provider-terminal",
                    "dispatchId": row["dispatch"]["dispatchId"],
                    "providerCallId": row["provider"],
                    "observedAt": at,
                    "evidenceSha256": digest(canonical(record).encode()),
                }
                row["providerObservation"] = record
                self.journal.save(row)
            evidence = row["evidence"]
            charge = row["liabilityMicroUsd"]
        self.service.rpc(
            "reconcile_terminal",
            {
                "jobId": row["dispatch"]["jobId"],
                "evidence": evidence,
                "chargedMicroUsd": charge,
            },
        )
        row["phase"] = "settled"
        self.journal.save(row)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--initialize-journal", action="store_true")
    args = parser.parse_args()
    work = Path(args.state).resolve()
    if not work.is_dir():
        raise RuntimeError("persistent-state-directory-required")
    if args.initialize_journal:
        Journal.initialize(work / "dispatch.sqlite3")
        return
    lock = (work / "dispatcher.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    policy = json.loads(Path(args.policy).read_text())
    root = Path(__file__).resolve().parents[2]
    journal = Journal(work / "dispatch.sqlite3")
    service = Service(
        os.environ["FURY_SERVICE_ORIGIN"],
        os.environ["FURY_WORKER_TOKEN"],
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )
    worker = Dispatcher(service, Provider(root, work), journal, policy, root, work)
    worker.verify_source()
    while True:
        for row in journal.jobs():
            try:
                worker.recover(row)
            except Exception:
                print("reconciliation-pending", flush=True)
        try:
            row = worker.new_job()
            if row:
                worker.recover(row)
        except Exception:
            print("dispatch-paused-or-unavailable", flush=True)
        time.sleep(5)


if __name__ == "__main__":
    main()
