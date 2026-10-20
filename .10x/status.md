# Status

## Live 360° speed and quality: one PR (#38)

The user asked for everything in one PR, so it can be dropped as a whole if it isn't good enough.

- Spec: `specs/2026-10-20-live-360-speed-quality-design.md`, with the scope change noted at its top.
- Design records: ADR-001 to ADR-004.

### Built and merged on `claude/eager-ramanujan-m4j744`

- [x] Phase 1 (b97f317):
  - Lite start gate;
  - live profile;
  - decoded textures kept;
  - probe filter;
  - milestones to 1024;
  - shader warm-up;
  - intent prefetch of the chunk and the tracer.
- [x] Crossfade binding fix (78426c9), from the Phase 1 adversarial review.
- [x] Tracer struct-length cache patch (39f84a6). Byte-identical packing; roughly halves `setScene` CPU time.
- [x] Photoreal entry (f144386): opens on the Cycles image and dissolves on the first move.
- [x] Instant edits (06c919e):
  - persistent geometry, live only;
  - `texturesChanged()`;
  - history that survives surface edits (RESTYLED cap of 16);
  - restyled reprojection, with its WGSL validated on SwiftShader.
- [x] `?arc=N` orbit window (cec7c38), behind a flag and off by default.
- [x] Faster boot (089ddab):
  - scans prefetched on intent;
  - quiet-load counter bug fixed;
  - Studio look skips 7.76 MB of unseen hardscape scans.
- [ ] Trace-scale cap, bounce/clamp parity (7, 0/10), Ultra frame guard, guard tests. In progress (worktree agent).
- [ ] Adversarial review of the merged changes. In progress (6 lenses × 3 refuters).
- [ ] Real-GPU bench on the Vercel preview. This is the user's call; see the PR description.

### Full gate at 089ddab

- format, lint (0 warnings), typecheck and build all pass.
- vitest: 2656 passed, 1 failed. The failure is the pre-existing root-only `objects.test.ts` permission case.

### Out of scope, with reasons in ADR-004

- FSR, SSR/SSGI on High, the glossy-blur kernel patch, refine-while-moving, depth of field and the BVH worker.
- Scene content: scenery, facades and interior GLBs. Changing it would desync the view from the 400 Cycles images, and the GLB assets don't exist.

### Note

`origin/main` (PRs 35–42, backend: Vast dispatcher, shared interior views) is ahead of `main-branch`,
which is the PR's base and the repo's default. This branch merges cleanly into `origin/main`.
Retargeting is the user's call.
