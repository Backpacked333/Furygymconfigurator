# Photoreal rendering: path-traced stills, then real-time uplift

Status: in progress (stage 1 implemented, stage 2 pending)
Owner: SDE
Requested: "the details, the surroundings, the textures, the realism ... leagues above". The user
chose **both, path tracing first**: resting views and exports path trace; orbiting stays real-time.

## Decisions

1. **Path tracer: `three-gpu-pathtracer` 0.0.27, WebGPU backend (pinned exact).**
   It runs compute kernels on the app's existing `WebGPURenderer`, so no second WebGL context, no
   duplicate scene, and textures are shared. The WebGL 2 fallback keeps real-time rendering only.
   Pinned because 0.0.x releases change internals we touch (`_pathTracer.update()` for extra
   passes per frame).
2. **Rest detection in `RenderEffects`.** Raster renders while the camera moves and for its settle
   window; 220 ms after the image settles, tracing starts. Any camera move, design edit, or texture
   arrival hands the frame back to the rasterizer. The scene is re-captured (BVH, materials,
   lights) only when a fingerprint of geometry, transforms, materials, and lights changes;
   camera-only changes call `updateCamera()`.
3. **Capture-time stand-ins instead of a parallel scene.** `preparePathTraceScene` swaps in
   path-tracer-readable properties only around `setScene` and restores them synchronously:
   `userData.pathTrace = false` hides objects (sky dome, raster sun, dimension helpers),
   `material.userData.pathTrace` overrides plain PBR fields for TSL-only materials (foliage
   atlases, grass, palms, scanned ground, planar mirror), unlit meshes hide automatically, and
   volumetric glass becomes thin-walled glass tinted by its absorption (panes are open sheets).
4. **Sun and sky.** The raster directional light is replaced by a circular area light 12,000 ft
   away subtending the sun's true 0.53°, carrying the same irradiance, so shadows soften with
   distance and glossy/glass surfaces get real glints. The sky is a 1024×512 HDR equirect built on
   the CPU from `visuals.ts`: a line-for-line port of three's `SkyMesh` Preetham sky _and its
   cloud layer_, so traced and raster skies match. Calibration constants (SKY_SCALE, fill, ground
   albedo, studio softboxes) moved to `visuals.ts` and are shared by both renderers.
5. **Denoising: Open Image Denoise on WebGPU (`oidn-web` 0.4.0, `rt_hdr_alb_nrm` weights,
   Apache-2.0, 1.8 MB, fetched only when tracing).** Milestones at 8/32/128/384/1024 spp: the
   accumulation is snapshotted, denoised with rasterized albedo/normal guides, and crossfaded in.
   Two denoisers alternate so a valid image is always on screen. Raw noise is never shown; if the
   denoiser fails, raw accumulation fades in instead (`?denoise=0` forces that for comparison).
6. **Presentation** goes through the same `finish()` (AgX, vignette, dither) as the raster
   image, plus a faint bloom on HDR highlights. The raster pipeline exposes its last HDR frame so
   the first traced image crossfades from it.
7. **Exports** (photo, PDF) wait for a ≥384 spp denoised image (45 s cap); without WebGPU they
   capture the raster frame as before. A status badge reports progress via a tiny external store
   so the scene tree never re-renders for it.
8. **three r186 bug workaround:** 3D storage textures are bound through 2D views; the existing
   `GPUTexture.createView` shim now requests the 3D view (a 2D view of a 3D texture is never
   valid).

## Rejected

- Separate WebGL2 context with the legacy `WebGLPathTracer`: duplicates the scene and textures in
  a second context and loses TSL materials; WebGPU-native tracer avoids both.
- Rendering the sky into an equirect on the GPU and reading it back: async readback complexity; the
  CPU port is deterministic and unit-tested.
- Delta directional sun in the tracer: razor-hard shadows and no sun glints.

## Verification

Headless Chromium here can run WebGPU compute but loses the device when presenting to a canvas,
so traced output is verified with a local offscreen harness (`dev-trace.html`, git-excluded) that
renders the real scene through the real pipelines into render targets and reads them back.

## Stage 2 (next)

Real-time realism uplift: higher-resolution scans, richer vegetation and facades, depth of field,
contact shadows, and the user's GLB assets per the interior asset brief.
