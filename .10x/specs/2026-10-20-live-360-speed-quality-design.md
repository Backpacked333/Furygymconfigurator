# Faster, sharper 360° view — plan

> **As shipped (PR #38, one PR):** ADR-002 to ADR-004 supersede parts of this plan.
>
> - Phase 2 items 1–4: a content-keyed geometry cache replaced material slots; sibling precompile
>   was dropped; the arc moved to `src/viewer/arc.ts` as `?arc=N`.
> - Phase 1 profile values: High and Ultra trace 7 bounces, and the trace scale comes from
>   `traceScale()`.
> - Phase 3 was cut as recorded in ADR-004.

## Context

You asked for a 360° view (library route, `?experience=library`) with more quality and realism, without
losing smoothness. That means a fast first open, near-instant response to configurator selections, and
quicker convergence to a clean image.

The discovery pass (PR Backpacked333/Furygymconfigurator#38) and two follow-up traces show that most of
the lost speed and quality comes from bugs and wasted work, not missing horsepower:

- **Lite stall.** On Lite (phones, viewports under 700 px) path tracing never starts at 60 Hz
  (`ProgressiveRenderer.tsx:200,218,231`). This was confirmed with a probe test.
- **Textures may trace black.** The live tracer never calls `keepDecodedTextures(true)`, so decoded
  maps are released after upload. The legacy route does this (`RenderEffects.tsx:340`); the library
  route does not.
- **Probe captures restart the trace.** Every raster probe capture fires `onMaterialsChanged('probe')`.
  `ProgressiveRenderer` invalidates the tracer for any change, so one edit forces up to 5 trace
  restarts and full BVH rebuilds. The tracer never uses the probes. `RenderEffects.tsx:458-465`
  already filters to `'textures'` only.
- **75% of the trace time shows nothing new.** Live targets 1024 spp, but denoise milestones stop at
  256 (`pathtrace.ts:414`). Nothing new is shown and the adaptive sampler stops retiring tiles.
- **A finish change rebuilds everything.** `shellKey` contains `c.finish` (`unitParts.ts:31`), so all
  nine unit lists rebuild, every mesh gets new geometry ids, and the tracer does a main-thread BVH
  rebuild. `siblings.ts` already proves finish and floor are pure material swaps.
- **Any edit throws away all sample history.** `history.clear()` runs on any signature change
  (`pathtrace.ts:574`). The reprojection kernel already demodulates by albedo (`history.ts`
  ReprojectKernel lines 124–149), so colour edits could keep it.
- **Everything starts on click.** There is no prefetch and no shader warm-up (`warmPipeline` exists but
  isn't called on this route). Each milestone also waits out a 520 ms crossfade.

Decisions you made:

- Lite gets **low-budget refinement**.
- Build **Phases 1–2 first**, then measure.
- Better scenes means all four areas (lighting, surroundings, interior, presentation). These go in
  Phase 3.
- You asked to evaluate a **180° arc with a slower spin**. My verdict is below and it's built into
  Phase 2.

## On the 180° arc + slower spin (honest assessment)

- **A narrower arc doesn't reduce cost per frame.** The GPU cost per frame is pixels × samples, and
  that doesn't change with how much of the circle is reachable.
- **It still pays off indirectly:**
  1. History reuse gets far denser. Three cached views cover a 180° arc much better than 360°.
  2. Scenery that the arc can never show can be dropped from the raster pass, which saves geometry
     and shadow-map cost.
  3. A capped angular speed makes reprojection and TRAA accurate between frames. That opens the way
     to **refining while moving slowly** (Phase 3) and to rendering at full resolution without
     smearing.
- **The arc must keep every customer camera reachable.** `rear-left-draft@1` is one of the 5
  customer views, so a "front-only ±90°" arc would cut it. The arc should be computed from the
  customer camera azimuths (front, front-left, left, rear-left) plus a margin. That is roughly
  180°, centred near the left-front.
- **Ship it behind `?arc=180` first** and compare time-to-quality against the free orbit before it
  becomes the default. Interior look-around keeps its current pitch clamp; yaw can be limited the
  same way.

## Phase 1: fixes and quick wins (one PR)

All of this is in `src/viewer/ProgressiveRenderer.tsx` unless noted.

1. **Lite stall.**
   - Replace the `remaining <= settleFrames - 6` arithmetic with a `drawnSinceChange` counter.
   - Start tracing when `drawnSinceChange >= 6 && now >= restAt` (plus the existing gates).
   - Keep invalidating until the trace has started or a gate blocks it (interaction, textures).
   - Add a **demand-loop** test that runs a frame only after `invalidate`, at 60 Hz, for `settleFrames`
     1 and 28. This is the probe from discovery, made permanent in `ProgressiveRenderer.test.tsx`.
2. **Live profile per quality tier.** Add a small `liveProfile(quality)` in `src/viewer/`:
   - Ultra/High: target 1024 spp, `maxBounces` 6, `fadeMs` about 260 ms.
   - Lite: `renderScale` 0.5, target 128 spp, `maxBounces` 4, otherwise the same.

   Pass it to `PathTraceSession`. Add `renderScale` and `fadeMs` options in `pathtrace.ts`; the
   constructor options already take `maxBounces`, `batchMs` and `maxPasses`. Six bounces matches
   the stills and the Cycles worker; the comment at `pathtrace.ts:503` says 10 added nothing
   visible.

3. **Decoded textures.** Call `await keepDecodedTextures(true)` before constructing the session, and
   `keepDecodedTextures(false)` on dispose, mirroring `RenderEffects.tsx:340/360`.
4. **Probe filtering.**
   - In the `onMaterialsChanged` listener, a `'probe'` change only marks the raster dirty when the
     view isn't tracing.
   - Only `'textures'` calls `tracer.invalidate()` and halts the trace.
5. **Milestones above 256.**
   - Append `512, 1024` to `MILESTONES` (`pathtrace.ts:414`). `advanceDenoise` already filters to
     `<= target`, so stills (256) and exports (384) are unaffected.
   - Make `FADE_MS` per-session from `fadeMs`; the stills path stays at 520.
6. **Prefetch on intent.**
   - On `pointerenter`, `focus` or `touchstart` of the "Explore in 360°" button (`ImageConfigurator.tsx`
     around line 655, via `StageToolbarView` props), call `import('./LiveDesignScene')`,
     `loadTracerModule()` and `prefetchTextures(...)` (`materials.ts:592`) for the current design's
     sets.
   - Don't prefetch on idle. The route promises that gallery browsing never loads three.js, and the
     boundary tests (`src/prototype/boundary.test.ts`, `scripts/display-client-boundaries.test.ts`)
     must stay green.
7. **Shader warm-up.**
   - Before the first `pipe.render()`, `await pipe.warm()` (`warmPipeline`, `pipeline.ts:132`, using
     `compileAsync`), with a short timeout fallback.
   - The loading label stays up until it resolves. This trades a sync hitch for async pipeline
     creation.
8. **Halve scene walks.** `begin()` computes `sceneParts` twice (`pathtrace.ts:544-545`). Compute it
   once and use `partsSignature(parts, key)`.

## Phase 2: instant selection changes, plus the arc experiment (second PR)

1. **Finish and floor as material swaps.**
   - Take `finish` out of `shellKey`/`openingKey` (`src/render/unitParts.ts:31-33`).
   - Batch by **material slot** (a stable role key such as `shell`, `frame` or `floor`) instead of
     material identity (`src/render/parts.ts` `batch`/`batchKeys`, `src/components/Parts.tsx:23` mesh
     key).
   - Resolve slot → material at mount (`StudioModel.tsx` list cache).
   - The geometry ids then stay stable. The tracer takes the `updateMaterials` path in milliseconds
     instead of `setScene`.
   - `siblings.ts`'s derivation logic is the spec for which fields qualify: finish, floor, and the
     frame colour chosen by contrast in `architecture.ts:41-49`. Interior style stays a rebuild.
2. **Keep history across material-only edits.**
   - In `begin()`, clear history only when `structure`, `transforms`, `lights` or `look` changed, not
     `materials` alone. `MultiViewHistory.store` clears on signature mismatch (`history.ts:498`), so
     key it on a geometry signature instead.
   - Lower `cap` for the first seed after a material edit (for example `HISTORY_SHARE` 0.5), because
     indirect bounce colour changes too.
3. **Precompile neighbouring materials.** After a view settles, build the sibling finish and floor
   materials with `material(spec)` and run `renderer.compileAsync`, reusing `siblings.ts`. The next
   click then never compiles shaders.
4. **180° arc and speed cap, behind `?arc=180`.**
   - Compute the azimuth window in `src/render/orbit.ts` from `CUSTOMER_CAMERAS`' gallery poses
     (`galleryCamera`, `src/render/gallery.ts`).
   - Set `minAzimuthAngle`/`maxAzimuthAngle` and a lower `rotateSpeed`, plus a max angular-velocity
     clamp in `CameraRig`'s glide.
   - Skip scenery that's never visible from the arc in raster only (`scenery.ts` keep-outs/layout).
     The tracer keeps everything that casts light, to protect GI correctness.
   - Bench both modes before deciding the default.

## Phase 3: outline only, decide after measuring Phases 1–2

- **Image quality:**
  - FSR upscaling with `renderScale` around 0.67, using three-gpu-pathtracer's `FSRUpscaler`.
  - `clampIndirect` 3–5 against fireflies, validated against a Cycles image of the same pose.
  - Adaptive comparisons every 1.5× instead of 2×.
- **Instant photoreal at entry:** the 360° view opens at the native image's exact camera
  (`resolveNativeCamera`). Show the Cycles 1024 spp image as the settled frame until the camera
  moves.
- **Refine while moving slowly:** within the speed cap, seed every frame from history.
- **Boot:** KTX2 or 1K-first textures, BVH built in a worker with `three-mesh-bvh` (already a
  dependency), and separate `drei`/tracer chunks.
- **Better scenes:**
  - Lighting: SSGI on High, SSR on High at 0.5 resolution.
  - Surroundings: denser planting and facade detail (the open Stage 2 items in `.10x/status.md`).
  - Interior: GLB assets per the interior brief.
  - Presentation: depth of field on settled frames and smoother gallery ↔ 360° transitions.

## Files touched in Phases 1–2

| Area                | Files                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Viewer              | `src/viewer/ProgressiveRenderer.tsx` (+ test), new `src/viewer/liveProfile.ts`                                                                                     |
| Path tracing        | `src/render/pathtrace.ts`, `src/render/history.ts`                                                                                                                 |
| Materials and parts | `src/render/materials.ts` (no API change expected), `src/render/unitParts.ts`, `src/render/parts.ts`, `src/components/Parts.tsx`, `src/components/StudioModel.tsx` |
| Camera              | `src/render/orbit.ts`, `src/components/CameraRig.tsx`                                                                                                              |
| Library route UI    | `src/prototype/ImageConfigurator.tsx`, `src/components/StageToolbarView.tsx` (prefetch hooks)                                                                      |
| Team state          | `.10x/` (ADR for material slots and history retention, plus SDE/QA records)                                                                                        |

## Verification

- **Every PR:** `npm run format:check && npm run lint && npm run typecheck && npx vitest run`, then
  `npm run build`. The baseline has 1 root-only failing test (`objects.test.ts` permission case);
  it's unrelated.
- **New unit tests:**
  - Demand-loop start for Lite and High.
  - Probe changes don't invalidate the tracer; texture changes do.
  - Milestones above 256 are selected only when target ≥ 512.
  - A finish change keeps geometry ids stable (`batch` slot keys) and keeps history.
  - Arc limits always include every customer camera pose.
  - Boundary tests stay green: no three.js in the gallery before intent.
- **Real-GPU check on the Vercel preview with `?experience=library&bench=1`.** Compare before and
  after for:
  - Click to first pixel.
  - Click to first refined image.
  - Finish change to refined image.
  - Seconds to the 256 spp image.
  - Frame time while orbiting, on a laptop (High/Ultra) and a phone (Lite).
- **Visual checks:**
  - Textured surfaces (brick, ground) aren't black in traced frames.
  - Exposure matches the gallery image at the entry pose.
