# QA report: live 360° speed and quality (PR #38)

## Automated verification (head 6a5739d)

- format, lint (0 warnings), typecheck and build all pass.
- vitest: 2706 passed, 35 skipped, 1 failed. Baseline before the PR was 2449 passed.
  - The single failure is `src/image-service/control-plane/objects.test.ts`, "fails closed on
    denied filesystem reads…".
  - It also fails on main-branch, and only when tests run as root, because root bypasses chmod.
- CI (`verify`, `render-server`) is green on every pushed head.

## How we verified

- **Fail-without proof.** Every behavioural change has a test, and each test was shown to fail on
  the pre-change source: the source was reverted temporarily, or a mutant was applied.
- **GPU is mocked everywhere.** The one exception is WGSL compile validation of the restyled
  reprojection kernel, run in headless Chromium on SwiftShader WebGPU.
- **Adversarial reviews,** each with multiple lenses and 3 independent refuters per finding:

| Review                           | Confirmed        | Fix                                                                                                                      |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase 1                          | 1 (pre-existing) | 78426c9: the crossfade read one texture binding                                                                          |
| Merged Phase 2 + entry           | 2                | 1f255f5: atlas growth after an in-place material update; 4314143: leftover orbit motion lifted the entry image on reopen |
| Trace-scale, parity, frame guard | 1 (low)          | 6a5739d: TRAA jitter left on the camera by a background compile                                                          |

Every other claim was refuted by a majority of verifiers.

## Key new test suites

- `src/viewer`: ProgressiveRenderer (demand loop, probe and texture routing, warm-up, guard), EntryWatch,
  presentation, liveProfile, frameGuard, arc and orbitWindow.
- `src/render`: parts cache, history keys and cap, `pathtrace` (`texturesChanged`, atlas growth, scale),
  tracerPatches, pipeline graph fingerprint, scanFiles.
- `src/prototype`: liveEntry (curtain), LiveViewport, LiveDesignScene, liveIntent, liveWarmup, boundary.
- `src/components`: Parts (identity across edits), SceneSurface, CameraRig (arc).
- A parity test checks `designTextures` against the builders across a matrix of configurations.

## Not verified (needs a real GPU)

The acceptance checklist is in `.10x/handoff.md`. The go/no-go items are:

- the tone and look jump when the entry image dissolves to the raster frame;
- traced textures render correctly (not black);
- a finish click updates in place, with no BVH rebuild;
- time to the first refined image, compared with main.
