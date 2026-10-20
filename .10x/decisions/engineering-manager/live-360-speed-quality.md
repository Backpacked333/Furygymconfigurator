# Live 360° speed and quality: delivery

## Phase 1 (this PR series, on the branch of PR #38)

1. Fix the start gate and add a demand-loop test (S).
2. Add `liveProfile` and the session options `renderScale` and `fadeMs` (S).
3. Keep decoded textures for the tracer's lifetime (XS).
4. Filter probe changes (XS) and add a test.
5. Add milestones up to 1024 and a test (XS).
6. Add the intent prefetch (S) and keep the boundary tests green.
7. Warm shaders before the first frame (S).
8. Walk the scene once in `begin()` (XS).

## Phase 2

Comes after the Phase 1 measurements: material slots, history retention, sibling precompile, and the
`?arc=180` experiment.

## Risks

GPU behaviour can only be proven on real hardware, through the Vercel preview with `?bench=1`.
