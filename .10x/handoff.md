# Handoff

**Where things stand.** Stage 1 (path-traced stills) is implemented in `src/render/pathtrace.ts`,
`src/components/RenderEffects.tsx`, `src/render/pipeline.ts` (`createTracePresent`), and
`src/lib/visuals.ts` (shared sky calibration, cloud port, equirect builder). Decisions are in
`.10x/decisions/sde/photoreal-rendering.md`.

**Speed work (stacked branch `claude/gifted-mccarthy-3c2zyf`).** `src/render/motion.ts` ends an
orbit's sub-pixel glide so the view comes to rest; `src/render/history.ts` keeps each traced view
and seeds the next one from it. Decisions in `.10x/decisions/sde/trace-speed.md`. The GPU check is
`dev-history.html` + `dev/history-harness.ts` (git-excluded), run like the trace harness below.

**How to verify locally.** Headless Chromium in the cloud container cannot present WebGPU to a
canvas (device lost) but can run WebGPU offscreen. `dev-trace.html` + `src/dev/trace.tsx`
(git-excluded) render a signature build through the real raster and trace pipelines into render
targets and draw them to 2D canvases. Launch Chromium with
`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader`. Do not
disable Dawn's lazy clear: uninitialized atlas pages then poison texture sampling (black images).
The session zero-fills the 3D energy table itself. Read back with the 256-byte row stride. It is
CPU-emulated: 320×200 reaches 16 spp in ~25–35 min.

**Gotchas.**

- `three-gpu-pathtracer` is pinned to 0.0.27; the session calls its internal
  `_pathTracer.update()` for extra passes per batch.
- The tracer's 3D GGX energy table must not auto-generate mipmaps (set in the session ctor).
- Path tracing presents nothing until the first image is ready, so the display does not pace it;
  the session keeps one GPU batch in flight via `queue.onSubmittedWorkDone()`.
- Any new TSL-only material needs `material.userData.pathTrace = { ...plain PBR fields }` or it
  will be traced with its default (white) properties.

**Next.** Stage 2 items in `.10x/status.md`; check the live crossfade on a real GPU via the Vercel
preview.
