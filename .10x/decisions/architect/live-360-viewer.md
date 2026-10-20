# Live 360° viewer — architecture [DISCOVERED 2026-10-20]

There are **two independent 360° implementations**.

## A. Library route (current direction, PR #30 `e362301`)

The viewer is built in layers, outermost first:

```
ImageConfigurator (live, viewerStarted, viewerReady state; toggleLive)
 └ LiveViewport            renderer-free; React.lazy boundary + error boundary + status labels
    └ LiveDesignScene      adapter: DesignEnvelope → Config (projectDesignToConfig), useStagedScene,
       │                   resolveNativeCamera(design) = exact saved-image camera, skyLook recipe
       └ SceneSurface mode="live"   R3F Canvas (WebGPU → WebGL2 fallback), device-loss rebuild ×3,
          │                         frameloop demand/never, Atmosphere/Landscape/StudioModel/probes
          ├ CameraRig      enters at the gallery pose; OrbitControls outside (limits in orbit.ts),
          │                yaw/pitch look-around inside; keyboard; glide-settle; reset easing
          └ ProgressiveRenderer (viewer/)   product-agnostic frame driver
               ├ createPipeline (raster, per quality tier)
               ├ PathTraceSession {multiView, maxBounces 10, batchMs 12, maxPasses 8}, target 1024 spp
               └ createProgressivePresentation: raster RT held until denoised trace crossfades in
```

- **Lazy start.** Gallery browsing never loads three.js. `viewerStarted` latches on the first toggle, and the canvas stays mounted afterwards (frameloop `never` while hidden).
- **No cloud fallback.** The live view never creates a cloud session or a paid render.
- **States.** `ViewerStatus` moves through loading → interactive ⇄ refining → settled. WebGL, or a tracer failure, gives `raster-only`.
- **When tracing starts.** All of these must hold:
  - the camera has not moved;
  - no pointer is held;
  - 150 ms of rest (`REST_MS`) have passed;
  - at least 6 raster frames have been drawn since the last change;
  - all requested textures have loaded.
- **What stops tracing.** Movement, a wheel event, a pointer-down, a hidden tab, an edit, a material or texture change, or `active=false`. Each of these halts the trace (`halt()` stores history).
- **Sample reuse (history).**
  - `MultiViewHistory` keeps up to 3 views, within 128 MiB at 36 B/px; it holds fewer at high DPI.
  - The best pose (`historyDistance`) seeds the next view by GPU reprojection. At most 75% of the target may come from history, and none for glass, metal or clearcoat.
  - Any change of scene signature clears the history.
- **Batch sizing.** GPU batches adapt toward 12 ms (`traceBudget.nextTracePasses`). An epoch counter fences stale async results.

## B. Legacy route (`/`, App.tsx + Scene.tsx + RenderEffects.tsx)

- **Modes.** `mode: 'gallery' | 'live'`. The gallery shows path-traced stills, with the canvas hidden underneath them.
- **Entering the 360° view.** The still stays as a "curtain" until the live view reports a settled run (`render/liveView.ts` `liveSettled` / `useSettledRuns`).
- **Leaving the 360° view.**
  1. `freezeLiveView` draws the last frame into a canvas.
  2. It returns the camera pose.
  3. The stage holds that frame until the nearest gallery angle's still is ready.
- **Shared parts.** RenderEffects owns the tracer here. `SceneSurface` and `CameraRig` were extracted from Scene.tsx so both routes share them.

## Failure modes

| Failure                      | Handling                                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| No WebGPU                    | WebGL2 raster only (`raster-only`)                                |
| No WebGL either              | `GraphicsBoundary` fallback; `ViewerBoundary` shows "unavailable" |
| Device lost                  | Renderer rebuilt up to 3 times, then the fallback                 |
| Tracer import or step throws | `raster-only` for the rest of the session                         |
| Denoiser fails               | Raw accumulation is shown                                         |
