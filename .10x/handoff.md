# Handoff

**Where things stand.** Stage 1 (path-traced stills) is implemented in `src/render/pathtrace.ts`,
`src/components/RenderEffects.tsx`, `src/render/pipeline.ts` (`createTracePresent`), and
`src/lib/visuals.ts` (shared sky calibration, cloud port, equirect builder). Decisions are in
`.10x/decisions/sde/photoreal-rendering.md`.

**How to verify locally.** Headless Chromium in the cloud container cannot present WebGPU to a
canvas (device lost) but can run WebGPU offscreen. `dev-trace.html` + `src/dev/trace.tsx`
(git-excluded) render a signature build through the real raster and trace pipelines into render
targets and draw them to 2D canvases. Launch Chromium with
`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader
--disable-dawn-features=lazy_clear_resource_on_first_use` (SwiftShader's lazy clear of 3D textures
is broken). It is CPU-emulated, so keep images small (≈240×150) and expect minutes per sample.

**Gotchas.**

- `three-gpu-pathtracer` is pinned to 0.0.27; the session calls its internal
  `_pathTracer.update()` for extra passes per batch.
- The tracer's 3D GGX energy table must not auto-generate mipmaps (set in the session ctor).
- Path tracing presents nothing until the first image is ready, so the display does not pace it;
  the session keeps one GPU batch in flight via `queue.onSubmittedWorkDone()`.
- Any new TSL-only material needs `material.userData.pathTrace = { ...plain PBR fields }` or it
  will be traced with its default (white) properties.

**Next.** Finish harness verification of all five builds (exterior and interior), then stage 2.
