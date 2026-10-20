"""Offline lifecycle checks: no cloud API, rented capacity or GPU is used."""

import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from on_demand.vast_runtime import Runtime
from on_demand.vast_provider import ssh_command
from on_demand.validation import validate_claim, verify_receipt
from on_demand.dispatcher import Dispatcher
from setup_vast_worker import verify_interpreter

ROOT = Path(__file__).resolve().parents[3]


class VastLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "jobs"
        self.state.mkdir()
        (self.root / "worker.json").write_text(json.dumps({"instanceId": 123}))
        (self.root / "recipe.json").write_text(json.dumps({"workerBuildSha256": "a" * 64, "gpuDevice": "NVIDIA GeForce RTX 5090"}))
        self.control = {"name": "fury-" + str(uuid4()), "instanceId": "123", "workerBuildSha256": "a" * 64, "timeout": 300}
        self.runtime = Runtime(self.control, self.state, self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def create(self, runtime=None):
        runtime = runtime or self.runtime
        with patch("on_demand.vast_runtime.subprocess.Popen") as popen, patch("on_demand.vast_runtime.process_identity", return_value="start-token"):
            popen.return_value.pid = 999999
            runtime.create()
        return popen

    def test_create_is_durable_and_duplicate_never_launches_another_process(self):
        popen = self.create()
        self.assertEqual(popen.call_count, 1)
        self.assertEqual(self.runtime.read()["pid"], 999999)
        self.assertEqual(self.create().call_count, 0)

    def test_two_distinct_slots_and_no_third_render(self):
        self.create()
        other = Runtime({**self.control, "name": "fury-" + str(uuid4())}, self.state, self.root)
        self.create(other)
        self.assertEqual({self.runtime.read()["uid"], other.read()["uid"]}, {10001, 10002})
        third = Runtime({**self.control, "name": "fury-" + str(uuid4())}, self.state, self.root)
        with self.assertRaisesRegex(RuntimeError, "worker-busy"):
            self.create(third)

    def test_uncertain_absent_create_is_fenced_before_reconciliation(self):
        self.assertEqual(self.runtime.find(), {"id": self.runtime.id})
        self.assertEqual(self.runtime.poll(), {"exitCode": 1})
        self.assertEqual(self.create().call_count, 0)
        with self.assertRaisesRegex(ValueError, "input-deadline"):
            self.runtime.send(io.BytesIO(b'{"bytes":4}\ndata'))

    def test_binding_rejects_other_instance_build_job_and_unbounded_timeout(self):
        for change in ({"instanceId": "456"}, {"workerBuildSha256": "b" * 64},
                       {"name": "../../escape"}, {"id": "vast:123:other"}, {"timeout": 2101}):
            with self.assertRaises(ValueError):
                Runtime({**self.control, **change}, self.state, self.root)

    def test_partial_transfer_is_never_retried_or_published_as_complete(self):
        self.create()
        with self.assertRaisesRegex(ValueError, "truncated-input"):
            self.runtime.send(io.BytesIO(b'{"bytes":10}\nshort'))
        self.assertFalse((self.runtime.directory / "input.stream").exists())
        with self.assertRaises(FileExistsError):
            self.runtime.send(io.BytesIO(b'{"bytes":4}\ndata'))

    def test_complete_input_is_atomic_and_not_sent_twice(self):
        self.create()
        self.assertEqual(self.runtime.send(io.BytesIO(b'{"bytes":4}\ndata'))["bytes"], 4)
        self.assertEqual((self.runtime.directory / "input.stream").read_bytes(), b'{"bytes":4}\ndata')
        with self.assertRaises(FileExistsError):
            self.runtime.send(io.BytesIO(b'{"bytes":4}\ndata'))

    def test_lost_or_reused_pid_kills_the_bound_slot_before_terminal_evidence(self):
        self.create()
        with patch("on_demand.vast_runtime.process_identity", return_value="other-process"), patch("on_demand.vast_runtime.kill_slot") as kill:
            self.assertEqual(self.runtime.poll(), {"exitCode": 1})
            kill.assert_called_once_with(10001)
        with patch("on_demand.vast_runtime.kill_slot") as kill:
            self.runtime.poll()
            kill.assert_not_called()

    def test_unconfirmed_cleanup_holds_capacity_and_liability(self):
        self.create()
        with patch("on_demand.vast_runtime.process_identity", return_value=None), patch("on_demand.vast_runtime.kill_slot", side_effect=RuntimeError("unconfirmed")):
            with self.assertRaisesRegex(RuntimeError, "unconfirmed"):
                self.runtime.poll()
        self.assertIsNone(self.runtime.read()["exitCode"])

    def test_missing_saved_and_current_identity_is_not_a_live_supervisor(self):
        self.create()
        row = self.runtime.read()
        row["processIdentity"] = None
        self.runtime.save(row)
        with patch("on_demand.vast_runtime.process_identity", return_value=None), patch("on_demand.vast_runtime.kill_slot") as kill, patch("on_demand.vast_runtime.os.kill") as signal_pid:
            self.runtime.terminate()
            signal_pid.assert_not_called()
            kill.assert_called_once_with(10001)
        self.assertEqual(self.runtime.poll(), {"exitCode": 1})

    def test_create_without_pid_identity_stops_supervisor_before_releasing_lock(self):
        with patch("on_demand.vast_runtime.subprocess.Popen") as popen, patch("on_demand.vast_runtime.process_identity", return_value=None), patch("on_demand.vast_runtime.kill_slot") as kill:
            popen.return_value.pid = 999999
            self.assertEqual(self.runtime.create(), {"id": self.runtime.id})
            popen.return_value.kill.assert_called_once()
            popen.return_value.wait.assert_called_once()
            kill.assert_called_once_with(10001)
        self.assertEqual(self.runtime.poll(), {"exitCode": 1})
        self.runtime.supervise()
        self.assertEqual(self.create().call_count, 0)

    def test_termination_signals_only_job_not_rental_and_release_preserves_evidence(self):
        self.create()
        self.runtime.send(io.BytesIO(b'{"bytes":4}\ndata'))
        frames = self.runtime.directory / "frames.log"
        frames.write_bytes(b"encoded-image-data")
        with patch("on_demand.vast_runtime.process_identity", return_value="start-token"):
            with self.assertRaisesRegex(ValueError, "job-still-running"):
                self.runtime.release()
        self.assertTrue(frames.exists())
        with patch("on_demand.vast_runtime.process_identity", return_value="start-token"), patch("on_demand.vast_runtime.os.kill") as kill:
            self.runtime.terminate()
            self.assertEqual(kill.call_count, 1)
            self.assertEqual(kill.call_args.args[0], 999999)
        row = self.runtime.read()
        row["exitCode"] = 0
        self.runtime.save(row)
        self.runtime.release()
        self.runtime.release()
        self.assertFalse((self.runtime.directory / "input.stream").exists())
        self.assertFalse(frames.exists())
        self.assertTrue((self.runtime.directory / "state.json").exists())
        self.assertEqual(self.runtime.poll(), {"exitCode": 0})

    def test_input_timeout_rejects_late_upload(self):
        self.create()
        row = self.runtime.read()
        row["createdAt"] = 0
        self.runtime.save(row)
        with self.assertRaisesRegex(ValueError, "input-deadline"):
            self.runtime.send(io.BytesIO(b'{"bytes":4}\ndata'))

    def test_provider_control_uses_pinned_host_key_and_excludes_credentials(self):
        env = {"FURY_VAST_HOST": "ssh.example.test", "FURY_VAST_PORT": "2200", "FURY_VAST_INSTANCE": "123",
               "FURY_VAST_SSH_KEY": "test-only-private-key", "FURY_VAST_KNOWN_HOSTS": "test-host-key"}
        with patch.dict(os.environ, env):
            command = ssh_command("create", self.control, self.root)
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertNotIn("test-only-private-key", " ".join(command))
        self.assertEqual((self.root / "key").stat().st_mode & 0o777, 0o600)
        data = json.loads(base64.urlsafe_b64decode(command[-1].rsplit(" ", 1)[1]))
        self.assertEqual(set(data), {"name", "timeout", "workerBuildSha256", "instanceId"})

    def test_dispatcher_provider_id_is_bound_to_instance_and_dispatch(self):
        worker = Dispatcher(None, None, None, {"providerKind": "vast-warm", "instanceId": "123"}, self.root, self.root)
        self.assertTrue(worker.valid_provider_id(self.runtime.id, self.control))
        for wrong in (None, "sb-other", self.runtime.id.replace("123", "456"), self.runtime.id + "extra"):
            self.assertFalse(worker.valid_provider_id(wrong, self.control))


class VastIsolationTests(unittest.TestCase):
    def test_setup_rejects_missing_or_different_pinned_python(self):
        with patch("setup_vast_worker.Path.is_file", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "pinned-python-required"):
                verify_interpreter()
        with patch("setup_vast_worker.Path.is_file", return_value=True), patch("setup_vast_worker.os.access", return_value=True), patch("setup_vast_worker.Path.resolve", side_effect=[Path('/pinned/python'), Path('/other/python')]):
            with self.assertRaisesRegex(RuntimeError, "pinned-python-required"):
                verify_interpreter()

    def test_inherited_internet_descriptors_close_without_breaking_unix_ipc(self):
        code = '''
import errno, os, socket
from on_demand.network_policy import block_internet
internet = [socket.socket(family) for family in (socket.AF_INET, socket.AF_INET6)]
descriptors = [s.detach() for s in internet]
left, right = socket.socketpair()
block_internet()
for fd in descriptors:
    try: os.fstat(fd)
    except OSError as e: assert e.errno == errno.EBADF
    else: raise AssertionError('internet descriptor survived')
left.send(b'local')
assert right.recv(5) == b'local'
'''
        subprocess.run([sys.executable, "-c", code], env={"PYTHONPATH": str(ROOT / "render-server")}, check=True)

    def test_network_denial_survives_exec_but_preserves_local_ipc(self):
        code = '''
from on_demand.network_policy import block_internet
import subprocess, sys
block_internet()
subprocess.run([sys.executable, '-c', """
import socket
socket.socket(socket.AF_UNIX).close()
for family in (socket.AF_INET, socket.AF_INET6):
    try: socket.socket(family)
    except PermissionError: pass
    else: raise AssertionError('network permitted')
"""], check=True)
'''
        subprocess.run([sys.executable, "-c", code], env={"PYTHONPATH": str(ROOT / "render-server")}, check=True)

    def test_gpu_and_execution_profile_are_bound_without_breaking_l40s(self):
        fixture = json.loads((ROOT / "src/render-library/fixtures/worker-adapter.json").read_text())
        claim = fixture["claim"]
        recipe = {"releaseId": "fury-native-five@2", "workerBuildSha256": claim["workerBuildSha256"], "recipeBundleSha256": claim["recipeBundleSha256"]}
        validate_claim(claim, recipe)
        recipe["gpuDevice"] = "NVIDIA GeForce RTX 5090"
        with self.assertRaises(ValueError):
            validate_claim(claim, recipe)
        claim["limits"].update(maxContainers=1, concurrencyPerContainer=2, minContainers=1)
        validate_claim(claim, recipe)


if __name__ == "__main__":
    unittest.main()
