# Status

## Live 360° speed and quality: one PR (#38)

The user asked for everything in one PR, so it can be dropped as a whole if it isn't good enough.

- Spec: `specs/2026-10-20-live-360-speed-quality-design.md`, with an as-shipped note at its top.
- Design records: ADR-001 to ADR-004.
- Commit map: `decisions/sde/live-360-speed-quality.md`.

### Phase

**Verification complete with a mocked GPU. Delivery is waiting on the real-GPU acceptance check**
(see `handoff.md`).

- [x] Phase 1: tiers, profile, decoded textures, probe filter, milestones, warm-up, intent prefetch
- [x] Photoreal entry, tracer struct-length patch
- [x] Instant edits: geometry cache, `texturesChanged`, history that survives surface edits
- [x] `?arc=N` orbit window (flag)
- [x] Boot: scan prefetch, quiet-load fix, Studio skips unseen hardscape
- [x] Trace-scale cap, Cycles bounce and clamp parity, Ultra frame guard, guard tests
- [x] Three adversarial reviews and a final verification. Confirmed findings are all fixed:
  - 78426c9: crossfade binding;
  - 1f255f5 and 14be578: atlas growth;
  - 4314143: reopen drift;
  - 6a5739d and d984686: view offset and aspect;
  - d984686: probe resettle.
- [ ] Real-GPU acceptance check on the Vercel preview. This is the user's call.

### Full gate

Format, lint (0 warnings), typecheck and build all pass. vitest: everything passes except the
pre-existing root-only `objects.test.ts` permission case. See the QA report for counts.

### Out of scope, with reasons in ADR-004

- FSR, SSR/SSGI on High, the glossy-blur kernel patch, refine-while-moving, depth of field and the
  BVH worker.
- Scene content. Changing it would desync the view from the 400 Cycles images.
- Follow-up: the comments in `render-server/fury_render/protocol.py` and `blender.py` still claim the
  browser and Cycles trace the same depth. They were left alone to keep this PR client-only.

### Note

`origin/main` (PRs 35–42, backend only) is ahead of `main-branch`, which is the PR's base and the
repo's default. The branch merges cleanly into both. Retargeting is the user's call.
