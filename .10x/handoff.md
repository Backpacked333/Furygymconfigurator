# Handoff

**Where things stand.** Phase 1 of the live 360° speed and quality plan is implemented (b97f317) on
`claude/eager-ramanujan-m4j744` (PR Backpacked333/Furygymconfigurator#38). The decisions are in
ADR-001. The build record is `decisions/sde/live-360-speed-quality.md` and the tests are in
`decisions/qa/live-360-speed-quality.md`.

## Next

1. **Real-GPU bench (user or QA).** Open the Vercel preview with `?experience=library&bench=1` and
   time:
   - click to first pixel;
   - click to the first refined image;
   - finish change to the refined image;
   - orbit frame time.

   Do this on a laptop (High/Ultra) and a phone (Lite). Also check that textured surfaces are not
   black when traced, and that exposure matches the gallery image at entry.

2. **Phase 2 (SDE).** Start with material slots:
   - take `finish` out of `shellKey` in `src/render/unitParts.ts`;
   - batch by slot in `parts.ts`, and change the `Parts.tsx` mesh key;
   - `siblings.ts` defines which fields qualify.

   Then history retention: in `pathtrace.ts` `begin()`, clear history only when
   structure, transforms, lights or look change, and key `MultiViewHistory` on a geometry signature.
