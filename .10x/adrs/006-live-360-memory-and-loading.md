# ADR-006: Less memory, a loading screen with no freeze, and visible refinement

**Status:** Accepted
**Date:** 2026-10-20
**Feature:** live-360-speed-quality
**Author:** 10x-Team (Architect + Staff Engineer)

## Context

The user kept the quality as it was and asked for three things:

- less RAM;
- no frozen, crash-like page after pressing 360°, but a loading screen;
- an aesthetic sense of progress, both while loading and while a still view refines.

Two choices were theirs:

- keep a closed view's memory for 30 s, then free it;
- a frosted pill with a ring and a phase label for refinement.

Every change here leaves the images identical: same samples, same geometry, same light.

## Decision

1. **Loading screen.**
   - It covers the stage from the press of 360° until the tracer's first start has happened (or
     cannot happen, or 15 s have passed).
   - It is a frosted scrim over the gallery image, with a card listing real steps: engine, scene,
     materials and light (a bar showing the share of scans in), path tracer.
   - Every animation is a transform or an opacity, so the compositor keeps it moving through long
     tasks.
   - The live renderer yields one painted frame before the scene mounts.
   - The gallery's eager code imports no renderer code. The steps come from the scene's lazy
     chunk as a prop (`LiveDesignScene` `useLiveProgress`), because:
     - the prototype boundary tests forbid `render/` in the gallery graph;
     - the private display and capture builds allow only their listed modules.
2. **Stalls moved off the main thread.**
   - **The tracer's per-mesh SAH BVHs**, its longest task, are built in `src/render/bvh.worker.ts`:
     - from copies of the arrays, with the tracer's own options;
     - attached as its build would leave them (same BVH and reordered index, tested for indexed,
       non-indexed and grouped geometry);
     - `setScene` skips geometries that already have one.
     - In headless Chromium, a 98k-triangle geometry built in the worker while the page kept
       animating. Built synchronously, it blocks for about 410 ms.
   - **The 1024×512 sky map** (about 0.6 s) is built in `src/render/sky.worker.ts`.
   - The first start waits for both, for at most 10 s.
   - Timeline marks: `fury:live-click`, `fury:live-first-frame`, `fury:live-bvh-worker`.
3. **Refinement pill.**
   - A frosted pill at the top right:
     - its ring fills on a log scale of the samples behind the image on screen;
     - it names the stage: light, then reflections (from 16 samples), then fine detail (from 128);
     - it shows "Fully refined" for 2 s, then fades.
   - It leaves when the camera moves. It never shows over the entry image or the loading screen.
4. **Memory.**
   - **Atlas from the GPU copies** (patched `AtlasTexture`).
     - The atlas used to draw a clone of every scan, which re-uploaded it from its decoded
       pixels. So the live view kept every scan decoded, about 500 MiB for a typical design.
     - It now draws the texture itself, with its uv transform set aside.
     - Checked by `scripts/atlas-check.mjs`: byte-identical pages, with the pixels freed first. A
       control that keeps the transform differs in 497k bytes.
     - Freed scans keep a `{width, height}` stand-in.
     - The legacy route's tracer still keeps its scans decoded.
   - **Atlas handover:** a capture frees the previous atlas before packing its own.
   - **One denoiser network** (`shareUNets`). The two denoisers alternate and never run at once.
   - **G-buffer MSAA not stored.** Its resolved bytes are identical on SwiftShader.
   - **30 s after closing**, `PathTraceSession.trim()` frees:
     - history, denoisers, snapshot and guides;
     - the entry image, other sky maps, and scan downloads that nothing took.

     The tracer, its BVH, atlas and kernels stay, so a reopen has no long capture.

   - `?memStats=1` logs the JS heap and the GPU memory three accounts for.

## Not done

- **Probe and G-buffer shader warm-up.**
  - The first probe capture runs in the first frame on purpose: the spin's design signature
    depends on probe-lit shaders existing from then.
  - Precompiling for the probe's cube render context risks that behaviour for an uncertain gain.
  - The loading screen covers it and keeps animating.
- **Dropping the ray pool's JavaScript copies** (about 117 MB at High/Ultra). three's storage-buffer
  bindings keep their own reference to the array, so freeing it needs a patch to three itself.
- **Indexed merged geometry.** `merge` also builds the legacy route's and the gallery stills'
  geometry. Changing its structure shifts scene signatures and cached renders, for a smaller gain.
- **Freeing the raster pipeline on close.** Rebuilding it recompiles its shaders, which is the stall
  this work removes.

## Consequences

- No number here was measured on a GPU. Check on a device:
  - `?memStats=1`;
  - Chrome's task manager;
  - the timeline marks.
- A reopen after 30 s starts unseeded and loads the denoiser network again. That is quick, and it
  happens behind the loading screen only if the scene was also unmounted.

## Follow-up: refinement speed

The first preview of this work refined visibly slower. Two causes were fixed, and one long-standing
one was removed:

- **The scene re-rendered for every progress report.**
  - `LiveDesignScene` read the progress stores as React state.
  - Every refinement report (each 2% of the pill's ring, several a second) reconciled the whole R3F
    tree on the main thread the trace's frames run on.
  - It now subscribes in an effect and hands the values to the gallery. Only the overlay and the
    pill render them, which is tested.
- **The pill's backdrop blur.** It sat over a canvas that changes every frame, so it was redrawn
  each time. It is gone (the glass is near opaque).
- **The GPU idled between batches (tried, then reverted).**
  - Two batches queued at once kept the GPU near fully busy.
  - On a device the view felt laggy: a press waited behind more queued work, and the browser's own
    compositing lost its headroom.
  - It is back to one batch at a time, 24 ms at rest. Throughput is not worth the snappiness.

Sobol was timed against blue noise on the convergence harness:

- the same time (60.1 s vs 60.2 s);
- lower error at 32 and 128 samples (8.3% vs 9.0%, 4.3% vs 4.9%).

It stays.

## Follow-up: snappiness and the boot after the loading screen

On a device, the view felt laggy and stuck, and it was slow to answer once the loading screen
left.

- **One batch on the GPU at a time again** (see above).
- **Tracing waits 150 ms of rest, as before, not 80.**
  - Each start draws the denoiser's guides, seeds from the kept views and queues a batch.
  - Each stop stores the view.
  - At 80 ms almost every hesitation in a drag paid for both, ahead of the next move's frame.
- **The denoiser's network loads behind the loading screen** (`PathTraceSession.prepareDenoiser`).
  - The first start waits for it beside the BVHs and sky map.
  - Before, its weights downloaded and were repacked on the main thread at the first denoise, just
    after the screen left.
- **The loading screen stays until the first batch has finished on the GPU**
  (`PathTraceSession.started`).
  - That batch builds the tracer's kernels synchronously, and the GPU draws nothing else until they
    are built: on some GPUs for seconds.
  - Building them ahead with three's `compileComputeAsync` was tried on SwiftShader and fails: the
    first sample sizes the buffers and textures they bind.
  - The 15 s limit still holds.
