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
