"""Offline doubles only. No provider, service credentials, rendering, upload or deployment."""

import base64
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from on_demand.dispatcher import Dispatcher, kill_tree
from on_demand.journal import Journal
from on_demand.sandbox_runner import extract, clean_env
from on_demand.validation import validate_claim, verify_receipt, verify_webp, digest
from on_demand.transport import Service

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "src/render-library/fixtures/worker-adapter.json").read_text()
)


class ServiceDouble:
    def __init__(self):
        self.calls = []
        self.claimed = False
        self.accepted = {}
        self.fail_event_once = False
        self.fail_ack_once = False
        self.uploaded = set()
        self.reject_upload = False
        self.reserved = 90
        self.dispatch_result = None

    def rpc(self, name, args):
        self.calls.append((name, copy.deepcopy(args)))
        if name == "claim_dispatch":
            if self.claimed:
                return None
            self.claimed = True
            return {
                "dispatch": copy.deepcopy(FIXTURE["dispatch"]),
                "claimToken": "00000000-0000-4000-8000-000000000004",
            }
        if name == "record_dispatch":
            result = args["result"]
            if self.dispatch_result not in (None, result) and not (
                self.dispatch_result["status"] == "uncertain"
                and result["status"] == "accepted"
            ):
                raise RuntimeError("TEST DOUBLE dispatch already recorded")
            self.dispatch_result = copy.deepcopy(result)
        if name == "dispatch_reservation":
            assert args == {
                "dispatchId": FIXTURE["dispatch"]["dispatchId"],
                "claimToken": "00000000-0000-4000-8000-000000000004",
            }
            return self.reserved
        if name == "reconcile_terminal":
            assert 0 <= args["chargedMicroUsd"] <= self.reserved
            return {"retrySafe": True}

    def claim(self, *_):
        self.calls.append(("worker_claim", {}))
        return copy.deepcopy(FIXTURE["claim"])

    def event(self, event):
        self.calls.append(("event", copy.deepcopy(event)))
        if self.fail_event_once:
            self.fail_event_once = False
            raise TimeoutError("TEST DOUBLE lost acknowledgement")
        if event["eventId"] in self.accepted:
            assert self.accepted[event["eventId"]] == event
            return {"accepted": True}
        if event["kind"] == "artifact" and event["eventId"] not in self.uploaded:
            return {"accepted": False}
        self.accepted[event["eventId"]] = event
        if self.fail_ack_once:
            self.fail_ack_once = False
            raise TimeoutError("TEST DOUBLE committed but lost acknowledgement")
        return {"accepted": True}

    def upload(self, event, path):
        self.calls.append(("upload", event))
        if self.reject_upload:
            raise RuntimeError("TEST DOUBLE expired upload claim")
        verify_webp(path, event["receipt"])
        self.uploaded.add(event["eventId"])


class ProviderDouble:
    def __init__(self, service, journal):
        self.service, self.journal = service, journal
        self.actions = []
        self.create_error = False
        self.find_id = None
        self.exit_code = 0
        self.frames = []
        self.crash = False

    def call(self, action, control, timeout=0):
        self.actions.append(action)
        if action == "create":
            assert any(k == "worker_claim" for k, _ in self.service.calls)
            assert self.journal.jobs()[0]["phase"] == "creating"
            if self.crash:
                raise KeyboardInterrupt(
                    "TEST DOUBLE process crash after remote acceptance"
                )
            if self.create_error:
                raise TimeoutError("TEST DOUBLE accepted then disconnected")
            return {"id": "sb-offline-test"}
        if action == "find":
            return {"id": self.find_id}
        if action == "send":
            return {"sent": True}
        if action == "poll":
            return {"exitCode": self.exit_code}
        if action == "terminate":
            return {"requested": True}
        raise AssertionError(action)

    def logs(self, *_):
        return iter(copy.deepcopy(self.frames))


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        Journal.initialize(self.root / "journal.db")
        self.journal = Journal(self.root / "journal.db")
        self.service = ServiceDouble()
        self.provider = ProviderDouble(self.service, self.journal)
        self.recipe = {
            "releaseId": "fury-native-five@1",
            "workerBuildSha256": "a" * 64,
            "recipeBundleSha256": "b" * 64,
        }
        self.policy = {
            "enabled": True,
            "approvalId": "OFFLINE-TEST-NOT-APPROVAL",
            "expiresAt": "2030-01-01T00:00:00Z",
            "maxJobLiabilityMicroUsd": 100,
            "globalBudgetMicroUsd": 200,
            "dispatcherId": "offline-test",
            "recipe": self.recipe,
            "appName": "never-used",
            "imageId": "im-never-used",
        }

        def prepare(row, directory):
            (directory / "scene").mkdir()
            views = [
                {**v, "sceneManifestSha256": "c" * 64, "cameraBindingSha256": "d" * 64}
                for v in row["claim"]["views"]
            ]
            (directory / "scene" / "job.json").write_text(json.dumps({"views": views}))
            package = directory / "input.tar"
            package.write_bytes(b"TEST DOUBLE")
            return package

        self.worker = Dispatcher(
            self.service,
            self.provider,
            self.journal,
            self.policy,
            self.root,
            self.root,
            prepare,
        )

    def tearDown(self):
        self.journal.db.close()
        self.tmp.cleanup()

    def test_claim_order_and_independent_terminal(self):
        self.provider.frames = [{"kind": "done", "outcome": "failed"}]
        self.provider.exit_code = None
        row = self.worker.new_job()
        self.worker.recover(row)
        self.assertEqual(self.provider.actions[:2], ["create", "send"])
        self.assertFalse(any(k == "reconcile_terminal" for k, _ in self.service.calls))
        self.provider.exit_code = 1
        self.worker.recover(row)
        self.assertEqual(row["phase"], "settled")
        evidence = [
            args for key, args in self.service.calls if key == "reconcile_terminal"
        ][0]
        self.assertEqual(evidence["evidence"]["kind"], "provider-terminal")
        self.assertEqual(evidence["chargedMicroUsd"], self.service.reserved)
        self.worker.recover(row)
        self.assertEqual(self.provider.actions.count("create"), 1)

    def test_uncertain_creation_never_resubmits_or_refunds_even_when_name_absent(self):
        self.provider.create_error = True
        row = self.worker.new_job()
        self.assertEqual(row["phase"], "uncertain")
        for _ in range(3):
            self.worker.recover(self.journal.jobs()[0])
        self.assertEqual(self.provider.actions.count("create"), 1)
        self.assertNotIn("send", self.provider.actions)
        self.assertFalse(any(k == "reconcile_terminal" for k, _ in self.service.calls))

    def test_process_crash_after_create_barrier_only_resolves_by_name(self):
        self.provider.crash = True
        with self.assertRaises(KeyboardInterrupt):
            self.worker.new_job()
        self.assertEqual(self.journal.jobs()[0]["phase"], "creating")
        self.provider.find_id = "sb-offline-test"
        self.worker.recover(self.journal.jobs()[0])
        self.assertEqual(self.provider.actions.count("create"), 1)
        self.assertNotIn("send", self.provider.actions)
        self.assertIn("poll", self.provider.actions)
        self.assertEqual(
            self.service.dispatch_result,
            {"status": "accepted", "providerCallId": "sb-offline-test"},
        )
        self.assertEqual(self.journal.jobs()[0]["phase"], "settled")

    def assert_durable_settlement(self, actual, ceiling):
        self.service.reserved = actual
        self.policy["maxJobLiabilityMicroUsd"] = ceiling
        self.policy["globalBudgetMicroUsd"] = 20000
        row = self.worker.new_job()
        row["liabilityMicroUsd"] = (
            ceiling  # Old journals must not determine settlement.
        )
        self.journal.save(row)
        self.policy["maxJobLiabilityMicroUsd"] = 18000
        self.policy["enabled"] = False
        self.worker.recover(self.journal.jobs()[0])
        proof = [a for k, a in self.service.calls if k == "reconcile_terminal"][-1]
        self.assertEqual(proof["chargedMicroUsd"], actual)
        self.assertEqual(self.journal.jobs()[0]["phase"], "settled")
        self.assertEqual(self.provider.actions.count("create"), 1)

    def test_full_set_settlement_uses_durable_reservation_after_restart_and_policy_change(
        self,
    ):
        self.assert_durable_settlement(5500, 6000)

    def test_partial_set_settlement_uses_durable_reservation_after_restart_and_policy_change(
        self,
    ):
        self.assert_durable_settlement(4500, 5500)

    def test_missing_durable_reservation_never_releases_liability(self):
        row = self.worker.new_job()
        self.service.reserved = None
        with self.assertRaisesRegex(RuntimeError, "durable-reservation-required"):
            self.worker.recover(row)
        self.assertFalse(any(k == "reconcile_terminal" for k, _ in self.service.calls))
        self.assertNotEqual(row["phase"], "settled")

    def queue_artifact(self, row):
        from PIL import Image

        path = self.root / "pending.webp"
        Image.new("RGB", (1920, 1200), (45, 50, 55)).save(path, "WEBP", quality=95)
        receipt = copy.deepcopy(FIXTURE["receipt"])
        receipt.update(bytes=path.stat().st_size, sha256=digest(path.read_bytes()))
        event = self.worker.event(row, 1, "artifact", receipt=receipt)
        self.journal.queue(row["dispatch"]["dispatchId"], event, path)
        return event, path

    def test_expired_artifact_replay_cannot_block_termination_or_settlement(self):
        row = self.worker.new_job()
        event, _ = self.queue_artifact(row)
        row["claim"]["deadlineAt"] = "2000-01-01T00:00:00Z"
        self.journal.save(row)
        self.service.reject_upload = True
        self.provider.exit_code = None
        self.worker.recover(self.journal.jobs()[0])
        self.assertIn("terminate", self.provider.actions)
        self.assertFalse(any(k == "reconcile_terminal" for k, _ in self.service.calls))
        self.provider.exit_code = 0
        self.worker.recover(self.journal.jobs()[0])
        self.assertEqual(self.journal.jobs()[0]["phase"], "settled")
        self.assertEqual(len(self.journal.pending(row["dispatch"]["dispatchId"])), 1)
        self.assertNotIn(event["eventId"], self.service.accepted)
        self.assertEqual(self.provider.actions.count("create"), 1)
        before = len([1 for k, _ in self.service.calls if k == "upload"])
        self.worker.recover(self.journal.jobs()[0])
        self.assertEqual(
            len([1 for k, _ in self.service.calls if k == "upload"]), before
        )

    def test_published_artifact_acknowledgement_recovers_after_expiry_without_file_or_upload(
        self,
    ):
        row = self.worker.new_job()
        event, path = self.queue_artifact(row)
        self.service.upload(event, path)
        self.service.fail_ack_once = True
        with self.assertRaises(TimeoutError):
            self.service.event(event)
        path.unlink()
        row["claim"]["deadlineAt"] = "2000-01-01T00:00:00Z"
        self.journal.save(row)
        self.service.reject_upload = True
        self.service.calls.clear()
        self.worker.recover(self.journal.jobs()[0])
        self.assertFalse(self.journal.pending(row["dispatch"]["dispatchId"]))
        self.assertEqual(self.service.accepted[event["eventId"]], event)
        self.assertFalse(any(k == "upload" for k, _ in self.service.calls))
        self.assertEqual(self.journal.jobs()[0]["phase"], "settled")
        self.assertEqual(self.provider.actions.count("create"), 1)

    def test_preparation_failure_is_never_submitted(self):
        def fail(*_):
            raise ValueError("TEST DOUBLE scene failure")

        self.worker.prepare = fail
        row = self.worker.new_job()
        self.worker.recover(row)
        self.assertEqual(self.provider.actions, [])
        proof = [
            args for key, args in self.service.calls if key == "reconcile_terminal"
        ][0]
        self.assertEqual(proof["chargedMicroUsd"], 0)
        self.assertEqual(proof["evidence"]["kind"], "never-submitted")

    def test_disabled_or_expired_policy_does_not_even_claim(self):
        for changes in (
            {"enabled": False},
            {"expiresAt": "2000-01-01T00:00:00Z"},
            {"maxJobLiabilityMicroUsd": 0},
        ):
            original = dict(self.policy)
            self.policy.update(changes)
            with self.assertRaises(RuntimeError):
                self.worker.new_job()
            self.policy.clear()
            self.policy.update(original)
        self.assertFalse(self.service.calls)
        self.assertFalse(self.provider.actions)

    def test_missing_journal_fails_closed_and_cannot_initialize_over_existing(self):
        with self.assertRaises(RuntimeError):
            Journal(self.root / "lost.db")
        with self.assertRaises(FileExistsError):
            Journal.initialize(self.root / "journal.db")

    def test_event_replay_and_completed_artifact_survive_lost_ack_and_failure(self):
        from PIL import Image

        image = self.root / "test.webp"
        Image.new("RGB", (1920, 1200), (45, 50, 55)).save(image, "WEBP", quality=95)
        data = image.read_bytes()
        receipt = copy.deepcopy(FIXTURE["receipt"])
        receipt.update(bytes=len(data), sha256=digest(data))
        camera = receipt["design"]["presentation"]["cameraRef"]
        self.provider.frames = [
            {"kind": "progress", "stage": "rendering", "cameraRef": camera},
            {"kind": "artifact-start", "receipt": receipt},
            *(
                {
                    "kind": "artifact-chunk",
                    "data": base64.b64encode(data[i : i + 16384]).decode(),
                }
                for i in range(0, len(data), 16384)
            ),
            {"kind": "artifact-end", "sha256": receipt["sha256"]},
            {"kind": "done", "outcome": "failed"},
        ]
        row = self.worker.new_job()
        self.service.fail_event_once = True
        self.provider.exit_code = None
        self.worker.recover(row)
        self.assertTrue(self.journal.pending(row["dispatch"]["dispatchId"]))
        self.provider.exit_code = 1
        self.worker.recover(self.journal.jobs()[0])
        events = list(self.service.accepted.values())
        self.assertEqual([e["sequence"] for e in events], [1, 2, 3])
        self.assertEqual(
            [e["kind"] for e in events], ["progress", "artifact", "terminal"]
        )
        self.assertEqual(self.provider.actions.count("create"), 1)
        self.assertEqual(events[1]["receipt"]["sha256"], digest(data))

    def test_forged_runtime_evidence_and_claim_are_refused(self):
        claim = copy.deepcopy(FIXTURE["claim"])
        validate_claim(claim, self.recipe)
        for field, value in [
            ("cpuFallback", True),
            ("samples", 32),
            ("quality", 90),
            ("completedSamples", 1000),
            ("backend", "CUDA"),
            ("device", "CPU"),
            ("renderSeconds", 301),
            ("width", 1280),
        ]:
            receipt = copy.deepcopy(FIXTURE["receipt"])
            receipt[field] = value
            view = {
                **claim["views"][0],
                "sceneManifestSha256": "c" * 64,
                "cameraBindingSha256": "d" * 64,
            }
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_receipt(receipt, claim, view)
        for field, value in [
            ("providerRetries", 1),
            ("jobSeconds", 2101),
            ("imageSeconds", 301),
            ("maxContainers", 3),
        ]:
            bad = copy.deepcopy(claim)
            bad["limits"][field] = value
            with self.assertRaises(ValueError):
                validate_claim(bad, self.recipe)
        bad = copy.deepcopy(claim)
        bad["identity"]["setKey"] = "set_" + "0" * 64
        with self.assertRaises(ValueError):
            validate_claim(bad, self.recipe)

    def test_archive_path_and_link_and_duplicate_members_refused(self):
        for names, kind in [
            (["../evil"], tarfile.REGTYPE),
            (["/evil"], tarfile.REGTYPE),
            (["blobs/" + "a" * 64], tarfile.SYMTYPE),
            (["job.json", "job.json"], tarfile.REGTYPE),
        ]:
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as archive:
                for name in names:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    info.size = 2
                    archive.addfile(info, io.BytesIO(b"{}"))
            with (
                tempfile.TemporaryDirectory() as target,
                self.assertRaises((RuntimeError, FileExistsError)),
            ):
                extract(
                    io.BytesIO(stream.getvalue()), Path(target), len(stream.getvalue())
                )

    def test_child_environment_excludes_provider_and_service_credentials(self):
        with patch.dict(
            os.environ,
            {
                "MODAL_TOKEN_ID": "TEST_ONLY",
                "SUPABASE_SERVICE_ROLE_KEY": "TEST_ONLY",
                "FURY_WORKER_TOKEN": "TEST_ONLY",
            },
        ):
            env = clean_env()
            self.assertNotIn("MODAL_TOKEN_ID", env)
            self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", env)
            self.assertNotIn("FURY_WORKER_TOKEN", env)

    def test_kill_tree_joins_child(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import time;time.sleep(60)"], start_new_session=True
        )
        kill_tree(child)
        self.assertIsNotNone(child.returncode)

    def test_signed_upload_binding_and_chunk_bound(self):
        class Connection:
            def __init__(self, *_, **__):
                self.chunks = []
                self.headers = {}
                connections.append(self)

            def putrequest(self, *_):
                pass

            def putheader(self, key, value):
                self.headers[key] = value

            def endheaders(self):
                pass

            def send(self, chunk):
                self.chunks.append(chunk)

            def getresponse(self):
                return type("Response", (), {"status": 200, "read": lambda *_: b""})()

            def close(self):
                pass

        connections = []
        ticket = copy.deepcopy(FIXTURE["uploadTicket"])
        receipt = copy.deepcopy(FIXTURE["receipt"])
        receipt["bytes"] = 40000
        ticket["maxBytes"] = 40000
        artifact = self.root / "arbitrary-test-bytes"
        artifact.write_bytes(b"x" * 40000)
        service = Service(
            "https://app.example", "TEST_ONLY", "https://storage.example", "TEST_ONLY"
        )
        with (
            patch("on_demand.transport.post", return_value=ticket),
            patch("on_demand.transport.http.client.HTTPSConnection", Connection),
        ):
            service.upload({"receipt": receipt}, artifact)
            self.assertEqual(max(map(len, connections[0].chunks)), 16384)
            self.assertEqual(connections[0].headers["x-upsert"], "false")
            ticket["overwrite"] = True
            with self.assertRaises(RuntimeError):
                service.upload({"receipt": receipt}, artifact)


if __name__ == "__main__":
    unittest.main()
