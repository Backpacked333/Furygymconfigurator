"""Offline protocol vectors, not a renderer, provider test, or image-quality claim."""
import copy
import hashlib
import json
from pathlib import Path
import unittest


FIXTURES = Path(__file__).resolve().parents[3] / "src/render-library/fixtures"
HTTP = json.loads((FIXTURES / "http-contract.json").read_text())
WORKER = json.loads((FIXTURES / "worker-adapter.json").read_text())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def view_design(design, camera):
    design = copy.deepcopy(design)
    design["presentation"]["cameraRef"] = camera
    if camera == "entry-draft@1":
        design["config"]["structure"]["addons"] = []
        design["config"]["structure"]["railing"] = "glass"
        design["config"]["appearance"]["finish"] = "obsidian"
        design["config"]["appearance"]["accent"] = False
    return design


def identity(design, kind):
    design = copy.deepcopy(design)
    design["config"]["structure"]["addons"].sort()
    if kind == "set":
        del design["presentation"]["cameraRef"]
    body = {"contractVersion": HTTP["contractVersion"], "kind": kind,
            "design": design, "recipeRelease": HTTP["identity"]["recipeRelease"]}
    if kind == "set":
        body["viewKeying"] = "camera-visible@2"
    payload = canonical(body)
    return ("set_" if kind == "set" else "img_") + hashlib.sha256(payload.encode("utf-8")).hexdigest(), payload


class WorkerProtocolTests(unittest.TestCase):
    def test_js_python_hash_parity(self):
        key, payload = identity(HTTP["design"], "set")
        self.assertEqual(key, HTTP["identity"]["setKey"])
        self.assertEqual(payload, HTTP["canonicalSet"])
        for camera, key in HTTP["identity"]["imageKeys"].items():
            design = view_design(HTTP["design"], camera)
            self.assertEqual(identity(design, "image")[0], key)
            if camera != "entry-draft@1":
                self.assertEqual(identity(design, "set")[0], HTTP["identity"]["setKey"])
        self.assertEqual(identity(HTTP["design"], "image")[1], HTTP["canonicalImage"])

    def test_adapter_binding(self):
        self.assertTrue(WORKER["testOnly"])
        self.assertEqual(set(WORKER["dispatch"]), {"contractVersion", "jobId", "dispatchId"})
        claim, receipt = WORKER["claim"], WORKER["receipt"]
        self.assertEqual(identity(claim["design"], "set")[0], claim["identity"]["setKey"])
        self.assertEqual(identity(receipt["design"], "image")[0], receipt["imageKey"])
        for field in ["jobId", "attemptId", "workerBuildSha256", "recipeBundleSha256"]:
            self.assertEqual(receipt[field], claim[field])
        self.assertEqual(len(claim["views"]), 4)  # Existing Night hero is never dispatched again.
        self.assertNotIn("front-left-draft@1", [v["cameraRef"] for v in claim["views"]])
        self.assertEqual(receipt["completedSamples"], 1024)
        self.assertFalse(receipt["adaptiveSampling"])
        self.assertFalse(receipt["cpuFallback"])
        self.assertEqual(receipt["backend"], "OPTIX")
        self.assertEqual(claim["limits"]["providerRetries"], 0)
        self.assertEqual(claim["limits"]["minContainers"], 0)
        self.assertEqual(WORKER["uncertain"]["status"], "uncertain")
        self.assertFalse(WORKER["uncertain"]["reason"]["retryable"])

    def test_scene_and_version_changes_are_not_equivalent(self):
        for patch in [{"lookRef": "desert-day-draft@1"}, {"aspect": "tall"}, {"doorPose": "open"}]:
            design = copy.deepcopy(HTTP["design"])
            design["presentation"].update(patch)
            self.assertNotEqual(identity(design, "set")[0], HTTP["identity"]["setKey"])
        payload = json.loads(HTTP["canonicalSet"])
        payload["recipeRelease"]["renderer"] = "not-the-same-release"
        key = "set_" + hashlib.sha256(canonical(payload).encode()).hexdigest()
        self.assertNotEqual(key, HTTP["identity"]["setKey"])


if __name__ == "__main__":
    unittest.main()
