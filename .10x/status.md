# Status

## Live 360° speed and quality (spec `specs/2026-10-20-live-360-speed-quality-design.md`, ADR-001)

**Phase 1: implemented (b97f317).** Awaiting real-GPU measurement before Phase 2.

- [x] Lite start-gate fix and demand-loop test
- [x] Per-tier live profile (6 bounces; Lite at half scale and 128 spp) with bilinear upsampling
- [x] Keep decoded textures for the tracer
- [x] Probe changes no longer restart the trace
- [x] Milestones to 1024; 260 ms live crossfade
- [x] Shader warm-up before the first frame
- [x] Intent prefetch of the 360° chunk and the tracer
- [x] Single scene walk in `begin()`
- [ ] Real-GPU bench: preview `?experience=library&bench=1`, before and after
- [ ] Phase 2:
  - finish and floor as material-slot swaps;
  - history kept across material-only edits;
  - sibling material precompile;
  - `?arc=180` experiment;
  - texture prefetch on intent
- [ ] Phase 3 (outline in the spec)

## Discovery (2026-10-20)

Done. See the `[DISCOVERED]` records.

Baseline vitest has 1 root-only failure: `image-service/control-plane/objects.test.ts`, the permission case.
