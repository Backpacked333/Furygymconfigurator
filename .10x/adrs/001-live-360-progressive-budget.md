# ADR-001: Live 360° refinement budget, triggers and history retention

**Status:** Accepted
**Date:** 2026-10-20
**Feature:** live-360-speed-quality
**Author:** 10x-Team (Architect + Staff Engineer)

## Context

The library route's live 360° viewer (`src/viewer/ProgressiveRenderer.tsx`) wastes most of its GPU time.

- **Lite never refines.** Under the R3F demand loop, a Lite view never starts tracing.
- **Probe events restart the trace.** Raster probe captures invalidate the tracer, forcing BVH
  rebuilds.
- **The last 768 samples show nothing.** Samples 256 to 1024 are never denoised or shown.
- **Edits discard all reprojection history.**

The user wants faster boot and selection response and better image quality, without losing
smoothness (spec: `specs/2026-10-20-live-360-speed-quality-design.md`).

## Decision

1. **Per-tier live profiles.** A pure `liveProfile(quality)` sets the sample target, bounces, trace
   render scale and crossfade length. Lite refines on a low budget (half-resolution trace, 128 spp,
   4 bounces). High and Ultra trace 6 bounces, matching the stills and the Cycles worker.
2. **Tracing starts on rest, measured in frames drawn.** Tracing starts after N raster frames drawn
   since the last change plus the rest time. The viewer keeps requesting frames until the start can
   be decided. It does not rely on the pipeline's `settleFrames`.
3. **Only scene-content changes invalidate the tracer.** These are texture arrivals and scene
   signature changes. Probe captures refresh the raster frame only.
4. **Denoise milestones double up to the target.** They continue past 256 (512, 1024), so long
   targets keep showing progress and keep feeding the adaptive sampler.
5. **History survives material-only edits (Phase 2).** It is keyed on a geometry/light signature and
   seeded with a reduced share. Finish and floor become material-slot swaps that keep geometry
   identity.

## Alternatives Considered

| Alternative                            | Pros                  | Cons                                                                                     | Why Not                                        |
| -------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Lower `LIVE_SAMPLES` to 256 everywhere | Trivial               | Gives up the quality headroom on capable GPUs                                            | Milestones above 256 keep the headroom useful  |
| Raster-only on Lite                    | Battery-friendly      | User chose low-budget refinement                                                         | Rejected by the user                           |
| Off-device (cloud) refinement for 360° | Strong GPUs           | Paid, latency per frame, explicitly excluded by the route ("No cloud render is started") | Out of policy                                  |
| Keep 10 live bounces                   | Marginal bounce light | About 1.5× cost per sample; the stills found no visible gain                             | Parity with the stills and Cycles matters more |

## Consequences

### Positive

- Lite refines.
- Edits no longer trigger multiple BVH rebuilds.
- Progress stays visible up to the target.
- Faster convergence per second.

### Negative

- Traced Lite images are softer at half resolution.
- More denoise passes per view: two more milestones.

### Risks

- **Exposure drift.** 6 bounces could shift exposure slightly compared with 10. Mitigation: visual
  check against the gallery image at the entry pose.
- **Stale probe lighting.** Ignoring probe changes while tracing could leave the raster capture stale.
  Mitigation: the raster is re-captured on the next trace start.

## Dependencies

- three-gpu-pathtracer 0.0.27 (pinned and patched): `renderScale`, `maxBounces`.
- OIDN denoiser.
- Constrains Phase 3 FSR work: the trace render scale becomes part of the profile.
