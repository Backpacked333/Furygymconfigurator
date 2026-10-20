# P03 — private configuration-only rendering preparation

## Scope and verdict

P03 prepares a validated v4 design for the **owned private Three worker**, without asking the customer browser to build a scene. It produces reproducible geometry/material/camera receipts, an actual compiled private-worker build closure, a pinned asset inventory and a blocked strict-reference job manifest. No render, browser process, GPU allocation or reference dispatch is part of the preparation command.

This is an engineering handoff, **not legal clearance or renderer qualification**. Fixed arrangements, materials, framing and engineering remain draft. Asset rights are held; generic canvas fonts are not pinned; a faithful Cycles/Unreal conversion is not implemented. The retained 640×400 Obsidian/Bronze software images belong to the previous source identity and remain pipeline evidence only. They are not regenerated or relabelled as P03 output.

## Boundary and data flow

```text
strict DesignEnvelope (configuration only)
  → private Node preparePrototypeScene
      → fixed arrangements + authored Fury builders
      → CPU geometry/material-spec/transform receipts
      → pinned-file byte validation + separate rights holds
      → resolvePrivateThreeSceneInput
          → full projected config + camera/framing + environment/look recipe
  → private bundle compilation + exact source/dependency/asset closure
  → exclusive manifest directory + COMPLETE marker

future separately authorized private capture
  → same resolvePrivateThreeSceneInput
  → CaptureAssembly: Atmosphere / Landscape / StudioModel / probes
  → actual TSL materials, texture decode, fixtures and canvas generation
```

The image-first customer path continues to request/display exact images. It does not import `prepare.ts`, its Node loader, the fixture catalog or the private worker. `capture/host.ts` enforces the private browser module allowlist; its production-bundle isolation test remains in place. The default v3 route and selected B UI are unchanged by P03.

There are two deliberately different receipts:

1. **CPU-owned resources:** real geometry buffers and matrices with authored material specifications. These material holders do not execute TSL shaders or decode pixels and are not render-ready materials.
2. **Private reconstruction instructions:** the complete strict design, projected configuration, authored camera and deterministic scenery/lighting recipe. The private scene consumes the same resolver and reconstructs omitted CPU effects from source-bound components. The compiled bundle manifest pins the code/dependency bytes that perform this reconstruction.

Neither receipt is a GLB/USD, a serialized complete Three scene or a Cycles payload. Cross-engine export must preserve the recorded coordinate, material, light, camera and identity semantics before execution can be qualified.

## All required controls

| Control           | Authoritative application                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed arrangement | `projectDesignToConfig` resolves the four fixed domain arrangements; `equipmentParts` / `StudioModel` consume those items. No customer positions or equipment edits. |
| Structure         | Typed Studio/Container shape, opening/infill, integrated finish, additions and railing feed the existing `UNIT_LISTS` and private `StudioModel`.                     |
| Finish            | Authored exterior/material palette selection, including equipment-independent structure finishes.                                                                    |
| Interior          | Authored interior material/geometry plus fixture style.                                                                                                              |
| Floor             | Authored floor material and texture specification.                                                                                                                   |
| Mirror            | CPU pane/frame geometry and the private worker's explicitly approximate Lite mirror path.                                                                            |
| Environment       | Versioned look → environment; deterministic scenery layout, authored sky/sun, ground/landscape and site probe.                                                       |
| Lighting look     | Look → time and fixture switch; view-specific exposure; authored sun/softboxes and `InteriorLights`. No measured-photometry claim.                                   |
| Door pose         | Strict closed/open state applied to the real operable geometry. Open-sided structures must use neutral closed pose.                                                  |
| Camera            | Shared `galleryCamera` resolver → position, target, vertical FOV, +Y up, near/far. No arbitrary input pose.                                                          |
| Aspect            | Independent wide 16:10 and portrait 4:5 camera calculation, frozen profile dimensions and frustum aspect. No implicit crop reuse.                                    |

`validatePrivateThreeSceneInput` recomputes every derived field from the embedded strict design. Changed geometry/config values, caller URLs, camera overrides, profile weakening, non-finite values and unknown fields cannot override trusted reconstruction.

## Frozen units, geometry and identity

- Source units: feet, **1 ft = 0.3048 m = 30.48 cm**.
- Right-handed; +Y up, +Z front, +X length; unit-centre/ground origin; finished floor **Y = 0.96 ft**.
- Column-major matrices. Fixed item placement: translation `(x, FLOOR_Y, z)` × rotationY(`-degrees`) × local part transform.
- Normals use inverse-transpose transforms. Negative determinants are recorded; a future baked-mesh exporter must correct winding. Procedural UVs are in feet.
- Actual little-endian attribute/index bytes, material specs, bounds and instance transforms are hashed; UUIDs and timestamps are excluded.
- Camera near/far are **0.1 / 2000 ft**, matching the private capture contract. They replace the old CPU-only 0.05/1000 draft values.
- Scene identity binds design, geometry/material/instance receipts, camera/look, full reconstruction recipe, asset validation and source/toolchain closure. Changing a camera/aspect produces a different case preparation identity.
- Source receipts include trusted render/domain files, actual component consumers, package/lock files, loader, texture generator and reference implementation sources. Missing files/symlinks fail. Source changes after module load invalidate preparation rather than combining stale geometry caches with newer source receipts.
- The actual private bundle separately records installed dependency sources and emitted worker/chunk bytes. Output arrays are sorted, including asynchronously collected build records.

These hashes prove identity/integrity, **not ownership, calibration, visual parity or pixel reproducibility across machines**. Node/V8/platform/architecture are recorded. Browser/driver/font/device/encoder identity remains a future execution prerequisite.

## Asset validation and rights

`assetInventory.json` contains explicit expected hashes and sizes for **78 local WebP files plus the attribution catalog**. The normal preparation command never regenerates this inventory. A changed asset requires a reviewed new inventory/source identity.

Validation checks allowlisted relative names, bounded sizes, no symlinks/path escape, exact bytes and mutation during reads. Missing, changed and unauthorized consumed resources fail closed. The private build's entire 78-texture closure must agree with these pins; merely matching the selected CPU material subset is insufficient.

Rights are validated as a **separate held state**: 24 upstream credit groups, three generated texture groups, Fury/product/equipment/brand rights, plus a font conversion hold. Public attribution and matching SHA-256 are not license approval. No rights status is upgraded by this implementation. See [asset rights evidence checklist](p03-asset-rights.md).

## Fixtures, compositions and strict references

| Fixture                                     | Special intent                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `studio-20-baseline`                        | Studio-20 fixed arrangement                                                     |
| `studio-40-baseline`                        | Studio-40 fixed arrangement / equipment consoles                                |
| `container-20-baseline`                     | Container-20 fixed arrangement                                                  |
| `container-40-baseline`                     | Container-40 fixed arrangement                                                  |
| `studio-40-night-mirror-glass-interior`     | Courtyard night, mirror, open sliding glass, chalk/slatted/oak                  |
| `container-40-roof-stairs-overhead-opening` | Roof, stairs, canopy, deck, full opening with raised overhead glass, cable rail |

Front-left + entry for all six = **12 compositions**. Add centre for difficult interior and top for structural stress = **14**. Each has wide + portrait = **28 independently prepared cases**. The original seven capture sample IDs and attempt/retry limits are unchanged; this preparation catalog is not permission to execute 28 captures.

`strict-reference-manifest.json` binds all 28 jobs to their exact case design, scene preparation, source, assets, materials, camera, look, exposure and reconstruction digests. Its strict candidate settings include:

- Cycles / Blender 4.5.0 reference candidate, not the display-renderer decision;
- requested and required completed samples **1,024 per pixel**;
- adaptive sampling off, native time limit zero, external cancellation fails the job;
- seed 0, animated seed off, no partial publication or lower-tier fallback;
- explicit bounce/clamp settings, CPU OpenImageDenoise RGB/albedo/normal FAST policy with no fallback;
- linear RGBA half-float EXR intermediate, explicit view transform and Three-style AgX/sRGB finishing source, gain, glow and per-view exposure;
- draft wide **1920×1200** / portrait **1200×1500** output dimensions, subject to art approval.

Every job and the manifest deny capture, reference dispatch, paid execution and production. The existing legacy Cycles service enables adaptive sampling/time bounds and permits denoiser fallback: **do not submit this manifest to that API**. A strict conversion/execution adapter must override those behaviors, pin worker/OCIO/OIDN/driver/font/output details, and independently prove completed samples. Requested samples are not measured completion evidence. No completed sample count is claimed here.

## Reproduce locally

Requirements: Node 24 (verified **24.22.0**), the checked-in npm lock and patched dependencies (`npm ci` in a fresh isolated checkout). No secrets, cloud account or graphics device is required. The existing native TypeScript loader emits an experimental API warning; that is not a graphics warning.

This unpublished local lane is intentionally pinned in `capture/host.ts`:

- source: `/home/ubuntu/Documents/fury-p03`;
- handoff: `/home/ubuntu/Documents/fury-p03-handoff`.

Changing these trusted roots is an explicit source change and invalidates receipts; arbitrary caller roots are not accepted. The retained real-image service still points at the separate original `fury-real` source and evidence, not this new bundle.

From the P03 source directory, choose new absolute output paths (the parent must already exist):

```sh
NODE_ENV=production node --import ./src/render/prototype/register.ts \
  ./scripts/prototype-fixtures.ts --out /home/ubuntu/Documents/fury-p03-handoff/review-A
NODE_ENV=production node --import ./src/render/prototype/register.ts \
  ./scripts/prototype-fixtures.ts --out /home/ubuntu/Documents/fury-p03-handoff/review-B
diff -qr /home/ubuntu/Documents/fury-p03-handoff/review-A \
  /home/ubuntu/Documents/fury-p03-handoff/review-B
NODE_ENV=production node --import ./src/render/prototype/register.ts \
  ./scripts/prototype-fixtures.ts --verify /home/ubuntu/Documents/fury-p03-handoff/review-A
```

`NODE_ENV=production` is required for deterministic private bundling, not permission to deploy. The command only prepares CPU resources and compiles code in memory. It does not import the capture runner, launch Chrome, start a service, decode textures, render or consume the capture ledger.

Each output has **45 files**: six fixture definitions, six fixture-default scenes, 28 case scenes, G1 manifest, strict-reference manifest, pinned inventory, private-build manifest and `COMPLETE.json`. The completion marker binds the other 44 files. It means preparation publication completed—not that any image exists.

The writer uses exclusive files in a new owned directory, checks bytes, fsyncs and publishes completion last. Existing directories, symlink parents and protected original evidence roots are refused. Failure leaves an incomplete directory; no implicit overwrite/recovery is provided. Verification reconstructs from current trusted sources/assets/build rather than trusting imported hashes and rejects missing, extra, changed or stale files. New source edits require a new output directory.

## Verification and remaining gates

Focused tests exercise every required control, recipe tampering, exact case identities, geometry/resource disposal, pinned-file failure paths, rights separation, strict-reference weakening/forgery, exclusive publication, deterministic replay and directory tampering. The actual private build isolation test checks its module graph. Private browser tests are Node unit tests; they are not a new UI or render pass.

Remaining before qualified rendering: clear rights/product/arrangement holds; pin fonts and worker dependencies; author/calibrate lighting/materials/framing; implement and validate strict reference conversion/execution; approve bounded hardware/costs; compare real outputs and measured latency. P03 does not select Three or Unreal, change the public image protocol, qualify G1, deploy or cut over the customer route.
