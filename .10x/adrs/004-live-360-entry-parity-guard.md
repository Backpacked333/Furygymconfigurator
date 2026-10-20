# ADR-004: Photoreal entry, Cycles-parity tracing, trace-scale cap, Ultra frame guard

**Status:** Accepted
**Date:** 2026-10-20
**Feature:** live-360-speed-quality
**Author:** 10x-Team (Architect + Staff Engineer)

## Context

The user folded every phase into one PR (#38), so the whole change can be dropped if it is not good
enough. The Phase 3 investigation (workflow `phase3-understand`) checked each candidate against two
hard constraints:

- No change to scene content. The 400 Cycles gallery images were rendered from the same `src/render`
  code via `scripts/native-render-*`.
- The legacy route stays unchanged.

## Decision

1. **Photoreal entry.**
   - The 360° view opens with the gallery's exact Cycles image still on screen. The live canvas is
     drawn under it at opacity 0, but still accepts focus and pointer input.
   - Once the camera leaves the image's pose by more than 0.5 px (`EntryWatch`, `motionPixels`), the
     canvas dissolves in over 300 ms, instantly under reduced motion.
   - The image also lifts when it stops being the current design's image, or when dimensions or
     auto-rotate are toggled.
   - This happens once per opening; Reset view does not cover the canvas again. Closing fades out.
   - Registration is the same camera function in both places (`resolveNativeCamera`), the same
     vertical FOV and the same aspect box. Probes measured an error of at most 1 px.
2. **Live bounce parity with Cycles.**
   - Cycles' `max_bounces = 6` is 7 shaded vertices in three-gpu-pathtracer. Its camera hit is
     bounce 0 and it terminates at `newBounce >= maxBounces`.
   - So High and Ultra live use `maxBounces: 7`, with explicit clamps direct 0 and indirect 10 (the
     recipe's values). Lite keeps 4.
   - Stills and exports are unchanged.
3. **Trace-scale cap.**
   - High and Ultra trace at the canvas resolution, capped at the Cycles reference's 1920×1200
     pixels: `traceScale = sqrt(REFERENCE_PIXELS / pixels)` above that. Lite stays at 0.5.
   - The scale is passed to `begin()` and set _before_ `syncSize`, so the tracer never resizes and
     drops the seed.
   - `?traceScale=0.5–1` overrides it for on-device A/B tests.
4. **Struct-length cache patch.** `PathtracerBVHComputeData` caches the fixed transform and
   material struct lengths, which roughly halves `setScene` CPU time. The packed buffers are
   byte-identical, which a test asserts.
5. **Ultra frame guard (live only).**
   - `createPipeline` gains optional `extras` that default to today's tier graph.
   - If the median raster frame while moving exceeds the budget on Ultra, the viewer rebuilds at
     rest without SSGI and SSR. `quality` is never touched, so scene content is unchanged.

## Alternatives Considered

| Alternative                           | Why Not                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| FSR upscaling                         | Needs a new dependency or an unvalidated node, 3 extra passes per frame, and an encode/decode step; the cap plus bilinear covers the need |
| Default trace scale 0.75              | Visibly softer than the Cycles image at entry on Retina screens                                                                           |
| SSR/SSGI on High                      | Adds little, moves the raster away from Cycles, and SSGI cannot run below full resolution                                                 |
| Cycles glossy-blur kernel patch       | Unvalidated WGSL that the legacy route also compiles; smallest benefit                                                                    |
| Refine while moving                   | A trace pinned to its start pose would drift 60–80 px; denoise restarts would never finish                                                |
| Depth of field                        | The Cycles gallery images use a pinhole camera                                                                                            |
| BVH build in a worker                 | The top-level tree stays on the main thread; risk of tangent-order mismatch                                                               |
| Re-cover with the image on Reset view | Would expose the tone mismatch side by side                                                                                               |

## Consequences

### Positive

- Opening the 360° view shows a photoreal frame immediately.
- Bounce depth matches the gallery.
- Big screens trace no more pixels than the reference holds.
- The first BVH freeze is about halved.
- Ultra is protected on integrated-GPU laptops.

### Negative

- The first move dissolves from the Cycles image to the _raster_ frame. Their tone and look differ
  (Blender AgX "Medium High Contrast" against three's base AgX at the live exposure). That
  difference is unmeasured and needs a GPU check.
- A 7th bounce costs about 2–8% more per sample (estimated).

### Risks

- Patch upkeep on the pinned tracer. A test guards that every hunk is present.
- The frame guard's budget is a judgment call without device data.

## Dependencies

ADR-001, ADR-002 and ADR-003. three-gpu-pathtracer 0.0.27 is pinned and patched.
