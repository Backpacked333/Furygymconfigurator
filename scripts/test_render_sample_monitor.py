import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("monitor", Path(__file__).with_name("render-sample-monitor.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.procs = self.base / "proc"
        self.proc = self.procs / "100"
        self.proc.mkdir(parents=True)
        self.lane = self.base / "fury-10001"
        self.root = self.lane / "native-test"
        self.root.mkdir(parents=True)
        self.image = "img_" + "a" * 64
        self.command = b"\0".join(v.encode() for v in (
            "python", "-m", "on_demand.renderer", str(self.root), self.image,
        )) + b"\0"
        (self.proc / "cmdline").write_bytes(self.command)
        (self.proc / "stat").write_text("100 (python) " + " ".join(["1"] * 30))
        self.job = {
            "claim": {"jobId": "11111111-1111-4111-8111-111111111111",
                      "attemptId": "22222222-2222-4222-8222-222222222222", "fence": 1},
            "views": [{"imageKey": self.image, "cameraRef": "front-draft@1"}],
        }
        self.save_job()
        (self.root / "blender.log").write_bytes(b"Sample 1/1024\nSample 528/1024\n")

    def save_job(self):
        (self.root / "job.json").write_text(json.dumps(self.job))

    def observe(self):
        return monitor.observe(self.procs, (self.lane,))

    def test_latest_actual_sample_and_identity(self):
        result = self.observe()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["completed"], 528)
        self.assertEqual(result[0]["jobId"], self.job["claim"]["jobId"])
        self.assertEqual(result[0]["imageKey"], self.image)
        self.assertEqual(result[0]["cameraRef"], "front-draft@1")

    def test_no_invented_progress_during_preparation(self):
        (self.root / "blender.log").write_bytes(b"Updating Scene\n")
        self.assertEqual(self.observe(), [])

    def test_completion_is_samples_not_artifact_success(self):
        (self.root / "blender.log").write_bytes(b"Sample 1024/1024\nDenoising\n")
        self.assertEqual(self.observe()[0]["completed"], 1024)

    def test_unbound_image_or_camera_is_ignored(self):
        self.job["views"][0]["imageKey"] = "img_" + "b" * 64
        self.save_job()
        self.assertEqual(self.observe(), [])
        self.job["views"][0] = {"imageKey": self.image, "cameraRef": "unknown"}
        self.save_job()
        self.assertEqual(self.observe(), [])

    def test_outside_root_and_batch_children_are_ignored(self):
        self.assertEqual(monitor.observe(self.procs, (self.base,)), [])
        (self.proc / "cmdline").write_bytes(self.command.replace(self.image.encode(), b"--batch"))
        self.assertEqual(self.observe(), [])

    def test_oversized_or_symlink_inputs_are_ignored(self):
        (self.root / "job.json").write_bytes(b" " * 65537)
        self.assertEqual(self.observe(), [])
        (self.root / "job.json").unlink()
        (self.root / "job.json").symlink_to(self.proc / "cmdline")
        self.assertEqual(self.observe(), [])

    def test_process_exit_or_pid_reuse_discards_observation(self):
        original = monitor.bounded
        reads = 0

        def read(path, limit):
            nonlocal reads
            if path.name == "stat":
                reads += 1
                if reads == 2:
                    return b"100 (python) " + b" ".join([b"2"] * 30)
            return original(path, limit)

        with patch.object(monitor, "bounded", side_effect=read):
            self.assertEqual(self.observe(), [])

    def test_invalid_samples_and_malformed_claim_are_ignored(self):
        (self.root / "blender.log").write_bytes(b"Sample 1025/1024\n")
        self.assertEqual(self.observe(), [])
        (self.root / "blender.log").write_bytes(b"Sample 1/1024\n")
        self.job["claim"]["fence"] = True
        self.save_job()
        self.assertEqual(self.observe(), [])

    def test_tls_setup_is_reused_without_network_io(self):
        monitor.publisher_opener.cache_clear()
        with patch.object(monitor.ssl, "create_default_context", wraps=monitor.ssl.create_default_context) as context:
            self.assertIs(monitor.publisher_opener(), monitor.publisher_opener())
            self.assertEqual(context.call_count, 1)
        monitor.publisher_opener.cache_clear()


if __name__ == "__main__":
    unittest.main()
