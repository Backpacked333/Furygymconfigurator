# ADR-005: Earlier first images, and the Cycles image as the first trace's start

**Status:** Accepted
**Date:** 2026-10-20
**Feature:** live-360-speed-quality
**Author:** 10x-Team (Architect + Staff Engineer)

## Context

The user asked for the first 20–30% of a resting view's gain to arrive sooner, and then for
algorithmic ideas that give faster, smoother refinement at the same or lower cost. They picked four:

- seed from the Cycles images;
- better random numbers (Sobol);
- smarter light picking;
- centre-first refinement.

Each was to ship on by default only where it measurably helps.

## Decision

1. **Timing (shipped).**
   - The rest gate is 80 ms and three frames, down from 150 ms and six.
   - Unseeded live views denoise at 2, 4 and 8 samples (`EARLY_MILESTONES`), with the count read every
     batch until the first image.
   - The first image fades in over 120 ms.
   - High and Ultra batches grow to 24 ms / 16 passes after one second of undisturbed tracing.
   - Each view's first image and milestones are marked in the performance timeline and the
     `?traceStats=1` log. `?firstImage=8` restores the old first milestone.
   - Stills and exports are unchanged.
2. **Seed from the Cycles image (shipped, `?cyclesSeed=0` to compare).**
   - The library image is read back to linear light through Blender 4.5's own AgX "Medium High
     Contrast" view, inverted with OpenColorIO from the config in the pinned `bpy` 4.5.0 wheel. The
     table is 25³, on a cosine-power shaper, read tetrahedrally. It is within about 1% of OCIO's own
     inverse below white, and greys stay grey.
   - A GPU kernel writes the image as a stored history view: 16 samples per pixel (8 on Lite), none
     at code ≥ 0.94.
   - The first start at the entry pose seeds from it through the existing reprojection checks, so
     glossy, metal and glass surfaces take none of it.
   - The view waits at most 800 ms for the decode.
   - The LUT is a 2D texture (blue slices stacked), because some Dawn backends upload 3D textures
     through an invalid 2D view. The same Dawn here rejected a 3D version.
   - Verified on SwiftShader WebGPU by `scripts/seed-check.mjs`: light within 1% of the CPU lookup,
     rows the right way up (a flipped-rows control fails it), averaging and the white cutoff.
3. **Sobol sampling (shipped, live only, `?sampler=blue` to compare).**
   - The tracer's default already draws Sobol numbers: the same sequence for every pixel, offset by
     a blue-noise dither. The alternative is Sobol scrambled per pixel (`RANDOM_SOBOL`).
   - `scripts/convergence.mjs` traced both with the real tracer on SwiftShader (64×40, 7 bounces as
     live, 3 runs each, against a 1024-sample reference). Error per sample, lower is better:

     | View      | Sampler           | 2 spp | 8 spp | 32 spp | 128 spp |
     | --------- | ----------------- | ----- | ----- | ------ | ------- |
     | room      | blue dither (old) | 33.8% | 18.9% | 8.8%   | 4.9%    |
     | room      | Sobol scrambled   | 34.8% | 18.0% | 8.3%   | 4.3%    |
     | equipment | blue dither (old) | 70.9% | 35.4% | 16.8%  | 8.9%    |
     | equipment | Sobol scrambled   | 69.6% | 32.3% | 16.0%  | 8.7%    |

   - Even at 2 samples, and 5–9% lower from 8 on: the same error for roughly 10–18% fewer samples.
   - What is shown is denoised, never the raw noise the blue dither is designed to make look
     smoother. OIDN is trained on independent per-pixel noise, which the scrambled sequence gives.
   - Stills and exports keep the default.
4. **Smarter light picking (dropped).**
   - The tracer already weights light selection by power, distance and spot cone
     (`LightsInfoNode.getLightWeight`). What remains is its TODO: culling lights below the surface's
     horizon.
   - On the harness gym, ray-cast per pixel with the tracer's own weights, the best-case share of
     selection weight on lights behind the surface is 0.5% (room view) and 1.5% (close to the
     equipment). That gives a direct-light efficiency gain of ×1.008 and ×1.023: below the 5% bar
     for a patch that would change the tracer's MIS bookkeeping (the previous vertex's normal) in
     two kernels.
5. **Centre-first refinement (dropped).**
   - The wavefront tracer draws pixels round-robin, and every pixel finishes at one global
     `maxSamples`. Milestone images wait for the minimum count over all pixels.
   - Throttling edge pixels would therefore delay every milestone image, centre included, which is
     the opposite of the aim.
   - The adaptive sampler already moves samples to regions still changing, once images exist.

## Consequences

- The first visible gain comes after roughly 80 ms plus two batches, not 150 ms plus eight samples.
  Real numbers come from the marks on a device.
- The seed assumes the tracer's light matches Cycles' for the same scene. That is designed in (same
  scene code, bounce and clamp parity) but unmeasured here. If it were off, the entry view's first
  images would shift toward the trace as samples arrive. Sixteen samples are outweighed by about 64
  real ones.
- The 2-sample first image is softer than the old 8-sample one. It is replaced within a few frames.
- `scripts/convergence.mjs` and `scripts/seed-check.mjs` give future changes a way to measure
  convergence and kernel correctness without a GPU, slowly.
