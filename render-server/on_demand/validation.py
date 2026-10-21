"""Credential-free runtime checks, shared with explicitly offline tests."""

import copy
import hashlib
import json
import re
from datetime import datetime, timezone

CONTRACT = "fury.render-library@1"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
CHUNK_BYTES = 16384
CAMERAS = (
    "front-left-draft@1",
    "front-draft@1",
    "left-draft@1",
    "rear-left-draft@1",
    "entry-draft@1",
)


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def digest(value):
    return hashlib.sha256(value).hexdigest()


def iso_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


INTERIOR_CAMERA = "entry-draft@1"
INTERIOR_KEYING = "interior-visible@1"
VIEW_KEYING = "camera-visible@1"


def identity(design, kind, release):
    design = copy.deepcopy(design)
    design["config"]["structure"]["addons"].sort()
    if kind == "set":
        del design["presentation"]["cameraRef"]
    body = {
        "contractVersion": CONTRACT,
        "kind": kind,
        "design": design,
        "recipeRelease": release,
    }
    if kind == "set":
        body["viewKeying"] = VIEW_KEYING
    return ("set_" if kind == "set" else "img_") + digest(canonical(body).encode())


def view_design(design, camera):
    """Canonical photograph inputs, matching src/render-library/views.ts exactly."""
    design = copy.deepcopy(design)
    design["presentation"]["cameraRef"] = camera
    if camera == INTERIOR_CAMERA:
        design["config"]["structure"]["addons"] = []
        design["config"]["structure"]["railing"] = "glass"
        design["config"]["appearance"]["finish"] = "obsidian"
        design["config"]["appearance"]["accent"] = False
    else:
        structure = design["config"]["structure"]
        if not any(addon in structure["addons"] for addon in ("roof", "stairs")):
            structure["railing"] = "glass"
        if (camera == "rear-left-draft@1"
                and not structure["addons"]
                and design["presentation"]["lookRef"] in (
                    "studio-day-draft@1", "studio-night-draft@1")):
            design["config"]["appearance"].update(
                interior="gallery", floor="rubber", mirror=False)
    return design


def validate_claim(claim, recipe):
    if claim["contractVersion"] != CONTRACT or not 1 <= len(claim["views"]) <= 5:
        raise ValueError("invalid-claim")
    for key in ("workerBuildSha256", "recipeBundleSha256"):
        if claim[key] != recipe[key] or not re.fullmatch("[a-f0-9]{64}", claim[key]):
            raise ValueError("release-mismatch")
    release = claim["identity"]["recipeRelease"]
    if release["id"] != recipe["releaseId"] or release["id"] != "fury-native-five@2":
        raise ValueError("recipe-mismatch")
    container = claim["design"]["config"]["product"]["family"] == "container"
    cameras = (
        "fury-container-open-exterior-entry-cameras@1"
        if container else "fury-native-five-cameras@2"
    )
    if release["cameras"] != cameras:
        raise ValueError("camera-recipe-mismatch")
    structure = claim["design"]["config"]["structure"]
    if container:
        operable = structure["opening"] == "roll-up" or structure["infill"] != "none"
        if claim["design"]["presentation"]["doorPose"] != ("open" if operable else "closed"):
            raise ValueError("container-door-pose")
    if identity(claim["design"], "set", release) != claim["identity"]["setKey"]:
        raise ValueError("set-mismatch")
    if set(claim["identity"]["imageKeys"]) != set(CAMERAS):
        raise ValueError("camera-set-mismatch")
    for camera in CAMERAS:
        design = view_design(claim["design"], camera)
        if identity(design, "image", release) != claim["identity"]["imageKeys"][camera]:
            raise ValueError("image-mismatch")
    seen = set()
    for view in claim["views"]:
        camera = view["cameraRef"]
        if (
            camera not in CAMERAS
            or camera in seen
            or claim["identity"]["imageKeys"][camera] != view["imageKey"]
        ):
            raise ValueError("invalid-missing-view")
        seen.add(camera)
    limits = claim["limits"]
    for key, ceiling in (
        ("startupSeconds", 180),
        ("preparationSeconds", 120),
        ("imageSeconds", 300),
        ("jobSeconds", 2100),
        ("maxContainers", 2),
        ("maxActiveJobsPerSession", 2),
        ("maxCreatesPerSessionPerHour", 60 if recipe.get("gpuDevice") else 3),
    ):
        if type(limits[key]) is not int or not 0 < limits[key] <= ceiling:
            raise ValueError("invalid-limit")
    for key, value in (
        ("providerRetries", 0),
        ("minContainers", 1 if recipe.get("gpuDevice") else 0),
        ("concurrencyPerContainer", 2 if recipe.get("gpuDevice") else 1),
        ("imagesPerJob", 5),
    ):
        if limits[key] != value:
            raise ValueError("invalid-limit")
    if recipe.get("gpuDevice") and (recipe["gpuDevice"] != "NVIDIA GeForce RTX 5090" or limits["maxContainers"] != 1):
        raise ValueError("invalid-warm-profile")
    return claim


def verify_webp(path, receipt):
    from PIL import Image

    if (
        not path.is_file()
        or path.is_symlink()
        or not 0 < path.stat().st_size <= MAX_IMAGE_BYTES
    ):
        raise ValueError("artifact-size")
    data = path.read_bytes()
    if len(data) != receipt["bytes"] or digest(data) != receipt["sha256"]:
        raise ValueError("artifact-checksum")
    with Image.open(path) as image:
        if image.format != "WEBP" or image.size != (
            receipt["width"],
            receipt["height"],
        ):
            raise ValueError("artifact-dimensions")
        image.load()


def verify_receipt(receipt, claim, view, device="NVIDIA L40S"):
    if device not in ("NVIDIA L40S", "NVIDIA GeForce RTX 5090"):
        raise ValueError("unsupported-device")
    for field in ("jobId", "attemptId", "workerBuildSha256", "recipeBundleSha256"):
        if receipt[field] != claim[field]:
            raise ValueError("receipt-claim-mismatch")
    design = view_design(claim["design"], view["cameraRef"])
    if receipt["design"] != design or receipt["imageKey"] != view["imageKey"]:
        raise ValueError("receipt-design-mismatch")
    for field in ("sceneManifestSha256", "cameraBindingSha256"):
        if receipt[field] != view[field]:
            raise ValueError("receipt-scene-mismatch")
    expected = {
        "contractVersion": CONTRACT,
        "recipeRelease": claim["identity"]["recipeRelease"],
        "samples": 1024,
        "completedSamples": 1024,
        "adaptiveSampling": False,
        "quality": 95,
        "device": device,
        "engine": "CYCLES",
        "backend": "OPTIX",
        "blenderVersion": "4.5.0",
        "cpuFallback": False,
        "mime": "image/webp",
    }
    for key, value in expected.items():
        if receipt.get(key) != value or type(receipt.get(key)) is not type(value):
            raise ValueError("receipt-evidence-mismatch")
    size = (1920, 1200) if design["presentation"]["aspect"] == "wide" else (1200, 1500)
    if (receipt["width"], receipt["height"]) != size or not 0 < receipt[
        "renderSeconds"
    ] <= claim["limits"]["imageSeconds"]:
        raise ValueError("receipt-size-or-time")
