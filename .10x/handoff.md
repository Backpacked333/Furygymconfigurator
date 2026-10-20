# Handoff

**Where things stand.** PR #38 (`claude/eager-ramanujan-m4j744`) carries the whole live 360° speed
and quality change. The commit map is in `decisions/sde/live-360-speed-quality.md`, status is in
`status.md`, and the decisions are ADR-001 to ADR-004.
Every item is limited to the library live viewer, and the legacy route behaves as before. The
investigations, with file:line evidence, live in the session scratch outputs. Their conclusions are
in the ADRs.

## Remaining

1. Real-GPU acceptance check (below). This is the user's call.
2. Merge, or drop the PR if the check fails. Rollback is in `decisions/devops/live-360-speed-quality.md`.

## GPU acceptance checklist (Vercel preview, `?experience=library`)

Add `&bench=1` and `&traceStats=1` for timings.

- **Opening the 360° view:**
  - the Cycles image stays until the first drag;
  - the dissolve has no ghosting;
  - the tone jump from Cycles to raster is acceptable. This is the go/no-go check.
- **Refinement:**
  - textured surfaces are not black when traced;
  - the trace refines on a phone (Lite);
  - images fade in, not cut.
- **Edits:**
  - a finish click restarts the trace seeded. `traceStats` logs "seeded".
  - the click causes no BVH rebuild: compare the `fury:trace-begin` measures
    (`performance.getEntriesByName('fury:trace-begin')`); a rebuild shows as a long one;
  - obsidian to chalk and rubber to oak trace correctly.
- **Timing and cost:**
  - compare time to the first refined image and frame time while orbiting against main;
  - check that the default Studio design downloads about 3.4 MB of scans, down from about 11.1 MB.
- **`?arc=180`:** reach every customer camera, and check the edge feel and the slow sweep.
- **While the entry image shows,** check GPU load, fan and battery: the trace refines unseen
  under it (ADR-004 risk).
