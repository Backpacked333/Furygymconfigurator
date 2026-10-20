# Local progressive 360° viewer

The native gallery (`?experience=library`) stays image-first. Its explicit 360° action lazily
loads `prototype/LiveDesignScene.tsx`; ordinary gallery browsing does not start Three.js or
load the tracer. The diagnostic image routes retain their existing restrictions.

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

To reuse this in another configurator, supply the scene contents, camera controls, a stable scene
revision and a `SkyLook` environment recipe to `ProgressiveRenderer` inside an R3F canvas made with
the shared renderer factory. The controller currently depends on FURY's material conventions and
sky recipe; it is an internal module, **not yet an independently packaged, product-agnostic SDK**.

## Sampling and lifecycle

The live profile targets up to 1,024 samples and ten bounces; the existing adaptive sampler may
retire settled tiles earlier. Its sample count is not a measure of newly traced rays.

- At most three compatible views are retained, bounded to 128 MiB of history textures. High-DPI
  views retain fewer or none rather than exceeding that budget. This excludes the tracer's other buffers.
- One best-matching view seeds the next accumulation. Existing world-position, normal, visibility,
  material and roughness checks remain; cached views are not summed together. At most 75% of the
  target can come from history, with fresh samples required for the remainder.
- All scene-signature changes conservatively invalidate lighting history. Existing selective
  BVH/material/light updates remain. This does **not** implement world-space edit-local GI reuse.
- GPU batches adapt toward a 12 ms budget, capped at eight passes; this is a scheduling target,
  not a guaranteed frame time. Already-submitted GPU work cannot be cancelled. Epoch checks fence
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
