# Live 360° speed and quality: what was built (Phase 1, commit b97f317)

## Built

| Change                                                                                                                                                                | Where                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Start gate counts raster frames drawn since the last change (`START_FRAMES` = 6) plus `REST_MS` 150. Frames are requested until the start is decided.                 | `src/viewer/ProgressiveRenderer.tsx`                                                                  |
| `liveProfile(quality)`. High and Ultra: 1024 spp, 6 bounces, scale 1, 260 ms fade. Lite: 128 spp, 4 bounces, scale 0.5.                                               | `src/viewer/liveProfile.ts`                                                                           |
| `PathTraceSession` options `renderScale` and `fadeMs`. `LONG_MILESTONES` [512, 1024]. `begin()` walks the scene once.                                                 | `src/render/pathtrace.ts`                                                                             |
| Manual bilinear upsampling (4 `textureLoad` taps per image), because the float storage textures may not be filterable.                                                | `src/viewer/presentation.ts`                                                                          |
| `keepDecodedTextures(true/false)` for the tracer's lifetime.                                                                                                          | `ProgressiveRenderer`                                                                                 |
| Probe changes redraw the raster only. `'textures'` invalidates the tracer.                                                                                            | `ProgressiveRenderer`                                                                                 |
| `pipe.warm()` (compileAsync) before the first frame, with a 1.5 s timeout.                                                                                            | `ProgressiveRenderer`                                                                                 |
| Intent prefetch: the toolbar's `onLiveIntent` (pointer, focus, touch) loads `LiveDesignScene`, which on load starts `loadTracerModule()` when `navigator.gpu` exists. | `src/prototype/liveIntent.ts`, `StageToolbarView.tsx`, `ImageConfigurator.tsx`, `LiveDesignScene.tsx` |

## Deviations from the plan

- **Texture prefetch is not built yet.** Prefetch covers the JS chunk and the tracer only. A per-design texture set list is a Phase 2 item.
- **Prefetch is a module side effect.** It runs when `LiveDesignScene` loads, guarded by `navigator.gpu`, and is not a separate exported function. This avoids a react-refresh lint warning and keeps the boundary test exemption narrow.

## Technical debt

- `liveProfile` values are first guesses. They need real-GPU timing through the Vercel preview with `?bench=1`.

## The full PR (one PR by the user's request): commit map

| Commit                             | What                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| b97f317                            | Phase 1: start gate, live profile, decoded textures, probe filter, milestones, shader warm-up, intent prefetch |
| 78426c9                            | Crossfade binding fix (from the Phase 1 review)                                                                |
| 39f84a6                            | Tracer struct-length cache patch                                                                               |
| f144386                            | Photoreal entry: EntryWatch, curtain, close fade                                                               |
| 06c919e                            | Persistent geometry, `texturesChanged`, history kept across surface edits, restyled reprojection               |
| cec7c38                            | `?arc=N` orbit window                                                                                          |
| 089ddab                            | Scan prefetch on intent, quiet-load counter fix, Studio skips hardscape                                        |
| 7023e89, eec4f11, 0cf69fb, 75c7279 | Guard tests, trace-scale cap, Cycles bounce and clamp parity, Ultra frame guard                                |
| 1f255f5, 4314143, 6a5739d          | Fixes from the merged-changes reviews: atlas growth, reopen drift, background-compile jitter                   |

## Deviations

- **Profile values superseded (ADR-004).** The Phase 1 table above records 6 bounces and a scale in
  `liveProfile`. The shipped code traces High and Ultra at 7 bounces with clamps 0/10, and the scale
  comes from `traceScale()` passed to `begin()`. The constructor's `renderScale` option was removed.

- **Material slots became a content-keyed geometry cache.** It keeps the same mesh identity with far
  less code (ADR-002).
- **Precompiling neighbouring materials was dropped.** Finishes already share one pipeline, and
  neighbours would have downloaded about 48 MiB of scans (ADR-002).
- **Scenery culling for the arc was deferred.** Toggling visibility changes the tracer's structure and
  costs global illumination and shadow casters (ADR-003).
- **Phase 3 was cut down.** FSR, SSR/SSGI on High, the glossy-blur kernel patch, refine-while-moving,
  depth of field and a BVH worker are excluded, with reasons in ADR-004.

## Technical debt

- Relies on internals of the pinned three-gpu-pathtracer 0.0.27: `_pathTracer`, `textureAtlas`, and
  struct nodes in the patch.
- The frame-guard budget (40 ms) and the live profile values need device data.
- The comment in `render-server/fury_render/protocol.py` still says the browser and Cycles trace the
  same depth. That is a follow-up outside this PR's scope.
