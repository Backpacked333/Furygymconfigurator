# Handoff

**Where things stand.** PR #38 (`claude/eager-ramanujan-m4j744`) carries the whole live 360° speed
and quality change; see `status.md` for the commit map and ADR-001 to ADR-004 for the decisions.
Every item is limited to the library live viewer, and the legacy route behaves as before. The
investigations, with file:line evidence, live in the session scratch outputs. Their conclusions are
in the ADRs.

## Remaining

1. Merge the trace-scale/parity/frame-guard branch (`p3-tracer-guard`).
2. Fix the confirmed findings from the merged-changes review.
3. Review the final diff once more, then hand over for the GPU bench.

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
  - a finish click restarts the trace seeded, with no BVH rebuild (`traceStats`);
  - obsidian to chalk and rubber to oak trace correctly.
- **Timing and cost:**
  - compare time to the first refined image and frame time while orbiting against main;
  - check that the default Studio design downloads about 3.4 MB of scans, down from about 11.1 MB.
- **`?arc=180`:** reach every customer camera, and check the edge feel and the slow sweep.
