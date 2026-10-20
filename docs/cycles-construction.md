# Private Cycles construction adapter

This is a real Blender scene-construction milestone, **not a rendered image or a qualified engine**. It accepts a validated v4 design through the private Node compiler, reconstructs trusted Fury parts and material specifications, verifies pinned texture bytes, and produces a local content-addressed package. No browser scene, asset URL, arbitrary camera, sample override, script or provider command is accepted by that compiler.

## What is implemented

- Fixed arrangement, structure, finishes, floor, interior, mirror-plane geometry and door pose come from P03's owned parts. World transforms are baked in feet with inverse-transpose normals; mirrored transforms reverse triangle winding. Shared source geometry is never mutated.
- Materials reuse the authored texture catalog and existing private Blender Principled-node conversion. Textures are decoded from verified local WebP blobs, not fetched. Linear material colors and texture color spaces are explicit.
- The bound camera preserves Three's right-handed +Y-up world frame. Blender's **vertical sensor fit** preserves the vertical field of view at both reference aspects. Scene scale is 0.3048 metres per world unit; no hidden geometry rescale occurs.
- Six comparison fixtures plus a portrait case are constructed in actual Blender 4.5.0 during tests. This does not run Cycles sampling.
- Strict construction settings fix 1,024 samples, disable adaptive sampling, time limits and sample subsets, ignore per-layer sample overrides, fix the seed, use CPU OIDN and preserve 16-bit uncompressed EXR settings. The adapter's `render()` refuses unconditionally.
- Package manifests bind the design, source and preparation digests, asset validation, camera, strict settings and content-addressed blobs. Python requires an expected digest supplied by the private compiler/operator, checks hashes, dependencies and byte limits before importing Blender. **Checksums are not authorization or a cryptographic worker attestation.** This is not an untrusted public package-upload API.

## Scene scope

The new image-first controls offer exactly four landscapes: **Residential courtyard, Corporate campus, Desert retreat and Studio**, each with **Day / Night**. Changing landscape retains Day/Night; changing lighting retains landscape. The old `studio-neutral-draft@1` remains readable as Studio/Day, but is not an additional selectable lighting mode. Existing look references keep their recipes; two new Studio references are drafts, not approved assets. The default legacy v3 interface remains unchanged.

## Explicit gaps: do not render or publish this package

The package contains **no converted world/sky, landscape meshes, vegetation, site probes or interior light fixtures**. The constructor uses a black world and no lights rather than silently substituting an attractive default. Studio Day/Night lighting rigs in particular still require authoring. Equipment console pixels and lettering/fonts remain missing. Glass, mirrors, occlusion maps, UV/normal conventions, material response, photometric scale and finishing need parity review. Approximate Principled materials are not equivalent to the browser's TSL shaders.

Setting `samples=1024` does not prove 1,024 completed samples. No completed-sample recorder, strict render executor, EXR publication acceptance or production P04 worker integration is implemented here. A successful construction receipt always says `renderAllowed: false`, `qualified: false` and `completedSamplesPerPixel: null`.

Rights, product/arrangement approval, art approval, a pinned production worker image and real-provider safety qualification remain holds. Unreal was not installed in the directories inspected on this development VM; access, licensing and a matched adapter remain unresolved. This is not an engine-selection decision.

## Reproduce locally (Linux, Node 24.22.0, Python 3.11)

Install JS dependencies using the root README. For an isolated Python environment:

```sh
uv venv --python 3.11 "$HOME/.venvs/fury-cycles"
uv pip install --python "$HOME/.venvs/fury-cycles/bin/python" --require-hashes -r render-server/requirements-construction.lock
```

Create a **new** package directory under an existing output parent. The compiler refuses to overwrite a directory. Use a credential-free shell/environment; no network is needed after installation.

```sh
node --import ./src/render/prototype/register.ts --input-type=module -e '
  import {defaultDesign} from "./src/domain/design.ts";
  import {writeCyclesConstruction} from "./src/render/prototype/cycles/compile.ts";
  console.log(writeCyclesConstruction(defaultDesign(), process.argv[1]));
' /absolute/owned/output/new-package
```

Save the digest printed above through a trusted local channel. From `render-server`, construct with that exact expected digest:

```python
from pathlib import Path
from fury_render.strict_construction import construct
studio, receipt = construct(Path('/absolute/owned/output/new-package'), 'sha256:COMPILER_DIGEST')
print(receipt)
```

Run the actual-Blender tests from `render-server` with the isolated environment; `node` must be on PATH:

```sh
"$HOME/.venvs/fury-cycles/bin/python" -m pytest -q tests/test_strict_construction.py
```

The normal TypeScript suite also exercises package replay, all six fixture identities, portrait/night separation, private input rejection and mirrored geometry. P04 tests now use fresh disposable temporary directories and the current checkout instead of writing into preserved handoffs or testing an older copy.

Dependency hashes lock package artifacts, not licenses or a complete production operating-system image. The local handoff records Blender's build, OIDN binaries, OCIO configuration and font hashes; font-to-render mapping is still unimplemented. No installation command enables a cloud API, allocates a GPU or authorizes rendering.
