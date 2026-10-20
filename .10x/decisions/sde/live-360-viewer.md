# Live 360° viewer — what is built [DISCOVERED 2026-10-20]

The design is described in `../architect/live-360-viewer.md`.

## Key files

| File                                        | Lines | Role                                                                                       |
| ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| `src/prototype/LiveViewport.tsx`            | 90    | Lazy/error boundary, labels, "No cloud render is started" copy                             |
| `src/prototype/LiveDesignScene.tsx`         | 76    | Adapter. `revision = JSON.stringify([config, dimensions, unit])`                           |
| `src/components/SceneSurface.tsx`           | 223   | Shared canvas. `dpr` is 1 on Lite, `[1, 1.5]` otherwise                                    |
| `src/components/CameraRig.tsx`              | 273   | Camera control (see below)                                                                 |
| `src/viewer/ProgressiveRenderer.tsx`        | 251   | Frame driver. `LIVE_SAMPLES=1024`, `REST_MS=150`                                           |
| `src/viewer/presentation.ts`                | 53    | Holds the raster RT and crossfades traced HDR through `stillFinish` (bloom, AgX, exposure) |
| `src/render/history.ts` + `historyCache.ts` | —     | Multi-view reprojection memory                                                             |
| `src/render/traceBudget.ts`                 | —     | Adaptive passes per batch                                                                  |
| `src/render/nativeCamera.ts`                | —     | Exact camera of the saved native image, including the container entry special case         |
| `src/render/liveView.ts`                    | —     | Legacy-route settle/freeze handshake                                                       |

`CameraRig.tsx` covers:

- exterior OrbitControls, limited to distance 12–170 ft and polar angle up to just under 90°;
- interior yaw/pitch look-around, with pitch clamped to ±0.7 rad;
- arrow-key and +/- keyboard control;
- easing back for reset and view switches;
- a stall guard on that easing.

## Technical debt

- Relies on the internal `_pathTracer` API of three-gpu-pathtracer 0.0.27.
- Two 360° implementations (legacy RenderEffects and ProgressiveRenderer) duplicate the lifecycle logic.
- `EXPORT_SAMPLES` is defined twice with different values: 384 in `pathtrace.ts` (local export) and 1024 in `lib/stillsManifest.ts` (stills export tier). Both are correct for their callers, but the shared name invites confusion.
- See QA finding F1 (Lite never starts tracing).
