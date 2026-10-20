# Local progressive 360° viewer

The native gallery (`?experience=library`) stays image-first. The 360° view loads on intent:
pointing at, focusing or touching its button (`prototype/liveIntent.ts`) starts loading
`prototype/LiveDesignScene.tsx`, which fetches the tracer and denoiser where WebGPU exists, and
`prototype/liveWarmup.ts` starts downloading the shown design's scans (encoded only, at low
priority, never under `saveData`). Gallery browsing without that intent starts no Three.js and
loads no tracer. The diagnostic image routes retain their existing restrictions.

## Boundaries

- `prototype/LiveViewport.tsx`: renderer-free loading/error boundary and honest preview labels.
- `prototype/LiveDesignScene.tsx`: FURY adapter. Projects the authoritative `DesignEnvelope`
  into the fixed-layout scene, resolves the native gallery camera, and supplies a revision and
  lighting recipe. The projected legacy `Config` is never written back into the design.
- `components/SceneSurface.tsx`: shared gym geometry, lighting, camera and WebGPU/WebGL canvas.
  The legacy `Scene.tsx` supplies its existing still/cloud controller; the library adapter supplies
  the local progressive controller instead. Entering live mode never creates a cloud session.
- `viewer/ProgressiveRenderer.tsx`: reusable R3F frame driver. Takes no product configuration,
  pricing or image-service dependency. Raster rendering handles movement; compatible WebGPU
  devices refine stationary views with the existing path tracer and denoiser. WebGL remains raster-only.
- `viewer/presentation.ts`: retains the raster frame and crossfades current traced images using
  the existing bloom, tone mapping and exposure treatment.
- `viewer/EntryWatch.tsx` and `viewer/entryPose.ts`: the view opens on the gallery's own Cycles
  image (its camera is the image's, `resolveNativeCamera`), drawn over the canvas until the camera
  leaves that pose by more than 0.5 px; the canvas then dissolves in over 300 ms (ADR-004). The
  curtain itself lives in `ImageConfigurator.tsx` and `LiveViewport.tsx`.
- `viewer/arc.ts` and `viewer/orbitWindow.ts`: the experimental `?arc=N` exterior orbit window
  (ADR-003). The library adapter computes it from the design's exterior customer cameras; the
  shared camera rig only applies it. The legacy route never passes one, so its orbit stays free.

To reuse this in another configurator, supply the scene contents, camera controls, a stable scene
revision and a `SkyLook` environment recipe to `ProgressiveRenderer` inside an R3F canvas made with
the shared renderer factory. The controller currently depends on FURY's material conventions and
sky recipe; it is an internal module, **not yet an independently packaged, product-agnostic SDK**.

## Sampling and lifecycle

The live profile targets up to 1,024 samples on High and Ultra, traced as deep as the gallery's
Cycles images: the tracer's `maxBounces` 7 is Cycles' `max_bounces` 6, since the tracer counts the
camera's hit as a bounce. Its clamps are the Cycles recipe's (direct 0, indirect 10). Lite targets
128 samples at four bounces. The stills and exports keep their own six. The existing adaptive
sampler may retire settled tiles earlier. Its sample count is not a measure of newly traced rays.

- High and Ultra trace at the canvas's drawing-buffer resolution, capped at the 1920×1200 pixels
  of the Cycles image the view opens on (`traceScale` in `liveProfile.ts`); Lite traces at half.
  The presentation filters the trace back up. `?traceScale=0.5`–`1` pins the High/Ultra scale for
  on-device comparisons. Each start is timed as `fury:trace-begin` in the performance timeline.
- At most three compatible views are retained, bounded to 128 MiB of history textures. High-DPI
  views retain fewer or none rather than exceeding that budget. This excludes the tracer's other buffers.
- One best-matching view seeds the next accumulation. Existing world-position, normal, visibility,
  material and roughness checks remain; cached views are not summed together. At most 75% of the
  target can come from history, with fresh samples required for the remainder.
- An edit of surfaces alone (a finish, a floor, scans arriving) keeps the retained views. The part
  lists keep their meshes and merged geometry (`render/geometryReuse.ts`), so the tracer updates
  materials in place instead of rebuilding its BVH, unless the update packs more textures than
  its kernels were compiled for (a new floor while the old one's scans stay in use elsewhere): then
  the scene is captured again, keeping each geometry's BVH. A view traced with other surfaces seeds at most
  16 samples (`RESTYLED_SAMPLES`) and ranks behind views of the current surfaces. Any other change
  of the scene (shapes, placement, lights, sky, emitters, glass) clears the history. The legacy
  stills and exports keep clearing it on any change. This does **not** implement world-space
  edit-local GI reuse.
- Ultra watches its raster frames while the camera moves (`viewer/frameGuard.ts`): if the median
  interval of 24 steady moving frames exceeds 40 ms (8 skipped after each change), the next rest
  rebuilds the raster pipeline without screen-space GI and reflections (`createPipeline` extras),
  once per session and never mid-drag. `quality` is never lowered, so the scene still matches the
  gallery's Cycles images; the traced image is unaffected. It is marked `fury:raster-shed` in the
  performance timeline. The budget is a judgment call without device data.
- Early refinement. A view rests after 80 ms and three raster frames (`REST_MS`, `START_FRAMES`).
  Its first denoised image comes at 2 samples, then 4 and 8 (`EARLY_MILESTONES`: OIDN's albedo and
  normal guides keep it clean, if softer). It fades in over 120 ms; later images fade in over 260 ms.
  `?firstImage=8` restores the old first milestone for comparison. Each view's first image and
  milestones are marked `fury:trace-first-image` and `fury:trace-milestone-<spp>` in the performance
  timeline, and listed in the `?traceStats=1` log.
- The entry's Cycles image seeds the first trace at its pose (`?cyclesSeed=0` turns this off).
  - The library image the view opens on is read back to scene-linear light. This uses Blender
    4.5's own AgX "Medium High Contrast" view, inverted: `render/agxInverse.bin`, built by
    `scripts/agx-inverse.py` from the OpenColorIO config in the `bpy` wheel the render server pins.
  - It is stored as a traced view at 16 samples per pixel (8 on Lite). Near-white pixels get none.
  - The first start there seeds from it through the usual reprojection checks, so view-dependent
    surfaces take none of it.
  - The start waits up to 800 ms for the image to decode.
  - Real samples outweigh it within the first milestones. The assumption is that the tracer's
    light matches Cycles' (same scene code, same bounces and clamps), which is unmeasured here. A
    mismatch would show as the first images' light shifting as samples arrive.
- GPU batches adapt toward a 12 ms budget, capped at eight passes; this is a scheduling target,
  not a guaranteed frame time. After a second of undisturbed tracing, High and Ultra take 24 ms
  batches of up to 16 passes, since the raster draws nothing then. A press waits at most one such
  batch. Already-submitted GPU work cannot be cancelled. Epoch checks fence
  obsolete measurements; movement, edits, pointer holds, hidden tabs and gallery return stop new tracing.
- The canvas/session stays mounted while returning to the gallery, but stops drawing. Closing the
  application disposes tracing, presentation and history resources. Re-entry starts at the selected
  gallery camera; arbitrary orbit poses are not saved as gallery images or design fields.

No ReSTIR, neural cache, portal guiding or GPU queue compaction is claimed here. No numerical
speedup or historical pixel parity has been established. Compare time-to-quality at equal hardware,
resolution and scene settings before making performance claims.

## Verification

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`

The controller lifecycle tests mock GPU calls; the shell tests verify the lazy boundary, current
design, edits, plan suspension, gallery return and absence of paid-render requests. They do not
prove rendered pixels. Browser acceptance should cover both families, selected interior/exterior
cameras, door/add-on addition **and removal**, finishes, lighting, held-pointer dragging, zoom,
revisiting angles, resize, close/reopen and WebGL fallback at laptop viewports. Hardware convergence
benchmarks require a real WebGPU device; software WebGL results are not laptop performance evidence.

Two checks run the real kernels on SwiftShader's WebGPU in headless Chromium (slow, CPU-bound):

- `node scripts/seed-check.mjs` checks the Cycles-image seed kernel against the CPU's reading of the
  same table: light, row order, averaging, and the near-white cutoff.
- `node scripts/convergence.mjs` traces a small gym-like interior with the real tracer and reports
  the error against a reference at 2–128 samples, to compare tracer settings at equal samples. It
  measures convergence per sample, not speed on any device.
