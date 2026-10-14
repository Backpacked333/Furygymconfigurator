"""Offline, hash-locked WebP -> PNG -> KTX2 experiment; never edits production assets.

python3 src/dev/asset-pilot/texture_pilot.py --ktx-bin /path/to/ktx/bin --output /outside/repo
Requires Pillow 12.3.0 / libwebp 1.6.0 and pinned KTX-Software Linux x86_64 4.4.0.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import time

import PIL
from PIL import Image, ImageChops, ImageOps, ImageStat, features

ROOT = Path(__file__).resolve().parents[3]
PROVENANCE = Path(__file__).with_name("provenance.json")
MAGIC = b"\xabKTX 20\xbb\r\n\x1a\n"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify(path, expected):
    actual = digest(path)
    if actual != expected:
        raise ValueError(f"Content changed: {path}: expected {expected}, got {actual}")


def mip_sizes(width, height):
    if not all(isinstance(v, int) and v > 0 for v in (width, height)):
        raise ValueError("Positive integer texture dimensions required")
    result = []
    while True:
        result.append((width, height))
        if width == height == 1:
            return result
        width, height = max(1, width // 2), max(1, height // 2)


def memory_model(width, height):
    levels = mip_sizes(width, height)
    return {
        "baseRGBA8Bytes": width * height * 4,
        "fullMipRGBA8Bytes": sum(w * h * 4 for w, h in levels),
        "fullMipBlock4x4_8ByteBytes": sum(math.ceil(w / 4) * math.ceil(h / 4) * 8 for w, h in levels),
        "fullMipBlock4x4_16ByteBytes": sum(math.ceil(w / 4) * math.ceil(h / 4) * 16 for w, h in levels),
        "levelCount": len(levels),
        "meaning": "Payload estimates only, not allocated GPU memory. 8-byte blocks: BC1/ETC RGB; 16-byte blocks: BC7/ASTC4x4/ETC RGBA. Actual format must be recorded per device/backend; RGBA8 fallback is possible.",
    }


def read_ktx_header(path):
    data = Path(path).read_bytes()
    if len(data) < 80 or data[:12] != MAGIC:
        raise ValueError("Not a complete KTX2 header")
    values = struct.unpack_from("<9I", data, 12)
    keys = ("vkFormat", "typeSize", "width", "height", "depth", "layers", "faces", "levels", "supercompression")
    header = dict(zip(keys, values))
    if header["levels"] < 1 or len(data) < 80 + 24 * header["levels"]:
        raise ValueError("Incomplete KTX2 level table")
    levels = [struct.unpack_from("<3Q", data, 80 + 24 * i) for i in range(header["levels"])]
    if any(offset + size > len(data) or not size for offset, size, _ in levels):
        raise ValueError("KTX2 level outside file")
    header["levelBytes"] = [size for _, size, _ in levels]
    return header


def encode_args(toktx, name, output, png):
    color = name == "albedo"
    # 4.4.0 help says --wmode, but its parser actually exposes --wrapping.
    args = [str(toktx), "--t2", "--genmipmap", "--wrapping", "wrap", "--lower_left_maps_to_s0t0",
            "--assign_oetf", "srgb" if color else "linear", "--assign_primaries", "bt709" if color else "none",
            "--target_type", "RGB", "--threads", "1"]
    if color:
        args += ["--encode", "etc1s", "--qlevel", "255", "--clevel", "2"]
    else:
        args += ["--encode", "uastc", "--uastc_quality", "2", "--zcmp", "18"]
        if name == "normal":
            args += ["--normalize"]
    return args + [str(output), str(png)]


def run(args):
    started = time.perf_counter()
    result = subprocess.run(args, capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {args}\n{result.stderr[-4000:]}")
    return {"argv": [str(a) for a in args], "wallMs": round((time.perf_counter() - started) * 1000, 3),
            "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ktx-bin", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or output.is_relative_to(ROOT):
        raise ValueError("Keep all generated assets outside the repository")
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(PROVENANCE.read_text())
    encoder = manifest["encoder"]
    if PIL.__version__ != encoder["pillowVersion"] or features.version("webp") != encoder["libwebpVersion"]:
        raise ValueError("Pillow/libwebp version drift; use the pinned offline tool environment")
    toktx, ktx = args.ktx_bin.resolve() / "toktx", args.ktx_bin.resolve() / "ktx"
    verify(toktx, encoder["toktxSha256"])
    verify(ktx, encoder["ktxSha256"])
    version = run([toktx, "--version"])
    decoder = manifest["decoder"]
    installed_three = json.loads((ROOT / "node_modules/three/package.json").read_text())["version"]
    if installed_three != decoder["version"]:
        raise ValueError("Three loader/decoder version drift; review and re-pin before comparison")
    decoder_files = []
    for suffix, key in [("js", "jsSha256"), ("wasm", "wasmSha256")]:
        path = ROOT / decoder["path"] / f"basis_transcoder.{suffix}"
        verify(path, decoder[key])
        data = path.read_bytes()
        decoder_files.append({"file": path.name, "sha256": digest(path), "rawBytes": len(data),
                              "gzip9Bytes": len(gzip.compress(data, compresslevel=9, mtime=0))})
    records = []
    for spec in manifest["textures"]:
        for name, expected_hash in spec["maps"].items():
            source = ROOT / "public/textures" / spec["set"] / f"{name}.webp"
            verify(source, expected_hash)
            with Image.open(source) as image:
                image = image.convert("RGB")
                width, height = image.size
                stem = f"{spec['set']}-{name}"
                png = output / f"{stem}.png"
                image.save(png)
                target = output / f"{stem}.ktx2"
                encoding = run(encode_args(toktx, name, target, png))
                expected = next(entry for entry in manifest["textureOutputExpectations"]
                                if entry["set"] == spec["set"] and entry["map"] == name)
                verify(target, expected["sha256"])
                if target.stat().st_size != expected["bytes"]:
                    raise ValueError("Encoded byte size drift")
                validation = run([ktx, "validate", target])
                extracted = output / f"{stem}-rgba.png"
                extraction = run([ktx, "extract", "--transcode", "rgba8", target, extracted])
                header = read_ktx_header(target)
                memory = memory_model(width, height)
                if (header["width"], header["height"], header["levels"]) != (width, height, memory["levelCount"]):
                    raise ValueError("KTX2 dimensions/mip chain changed")
                with Image.open(extracted) as decoded:
                    # Compressed textures do not use Texture.flipY; stored rows are lower-left.
                    upright = ImageOps.flip(decoded.convert("RGB"))
                    upright.save(output / f"{stem}-comparison.png")
                    error = ImageChops.difference(image, upright)
                    rmse = ImageStat.Stat(error).rms
                    max_error = [pair[1] for pair in error.getextrema()]
                source_bytes, ktx_bytes = source.stat().st_size, target.stat().st_size
                records.append({"set": spec["set"], "role": spec["role"], "map": name,
                    "tileFeet": spec["tileFeet"], "width": width, "height": height,
                    "webp": {"bytes": source_bytes, "sha256": expected_hash, "mipsTransferred": 1},
                    "ktx2": {"bytes": ktx_bytes, "sha256": digest(target), "header": header,
                             "colorSpace": "srgb" if name == "albedo" else "linear-data",
                             "orientation": "ru; physically row-flipped; compressed flipY=false"},
                    "transferDeltaBytes": ktx_bytes - source_bytes,
                    "memory": memory,
                    "accountedFallbackLiveBytes": ktx_bytes + memory["fullMipRGBA8Bytes"] * 2,
                    "accountedFallbackMeaning": "Encoded input + CPU RGBA mip payload + GPU RGBA mip payload only. Excludes decoder/worker heap, driver alignment, staging copies and renderer targets; NOT a peak-memory bound.",
                    "offlineRGBA8Error": {"rmseRGB_0_255": rmse, "maxRGB_0_255": max_error,
                       "meaning": "Incremental error against decoded already-lossy WebP; not original scan accuracy, normal angular error, compressed-target quality, lighting or shimmer acceptance."},
                    "offlineEncode": encoding, "offlineValidate": validation, "offlineExtractRGBA8": extraction,
                    "browserDecodeMs": None, "browserTranscodeMs": None, "gpuUploadMs": None,
                    "actualGpuFormat": None, "actualPeakWorkingSetBytes": None,
                    "webgl2Fidelity": None, "webgpuFidelity": None, "motionShimmer": None})
    totals = {key: sum(r[format_name]["bytes"] for r in records) for key, format_name in [("webpBytes", "webp"), ("ktx2Bytes", "ktx2")]}
    report = {"version": manifest["version"], "baseline": manifest["baseline"],
              "encoder": version, "pillow": PIL.__version__, "libwebp": features.version("webp"),
              "decoder": {**decoder, "files": decoder_files}, "records": records, "totals": totals,
              "decision": "NO production adoption from this offline experiment. Keep WebP fallback. Require device/backend target, decode/transcode/upload, visual normal/roughness/mip comparison and bounded worker ownership first.",
              "timingBoundary": "Offline encode/extract subprocess wall times include startup and file IO; extraction includes PNG writing. These are build diagnostics, NOT browser decode/transcode timings or comparative runtime wins."}
    (output / "texture-measurements.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(totals))


if __name__ == "__main__":
    main()
