# Live 360° speed and quality: operations

## Signals (browser-side; no backend SLO changes)

- **`performance.measure('fury:trace-begin')`:** the main-thread cost of each tracer start (BVH and
  atlas). Use it to confirm the struct-length patch's gain and to spot BVH rebuilds after edits.
- **`performance.mark('fury:raster-shed')`:** Ultra's frame guard dropped SSGI and SSR on a slow device.
- **`?bench=1` and `?traceStats=1`:** time to the first image and to the settled image, and whether a
  trace was seeded.

## Runbook

| Symptom                                  | Check / action                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 360° view never refines              | `?traceStats=1`. Check that WebGPU is present (WebGL is raster-only by design), and that `textureProgress` has loaded ≥ requested. The quiet-load counter fix is in 089ddab. |
| The entry image never lifts              | EntryWatch tolerance is 0.5 px. Check that the camera moves (the arc window at its limits?).                                                                                 |
| Black or wrong textures in traced frames | Atlas growth: check `fury:trace-begin` runs after a floor change (1f255f5). Check that `keepDecodedTextures` is held.                                                        |
| Janky orbit on Ultra                     | Look for the `fury:raster-shed` mark. If it is absent on a slow device, the guard's budget (40 ms median of 24) may need tuning in `src/viewer/frameGuard.ts`.               |
| Rollback                                 | See `decisions/devops/live-360-speed-quality.md`.                                                                                                                            |
