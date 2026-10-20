# Live 360° speed and quality: QA (Phase 1)

## Results

- typecheck, lint (0 warnings) and format all pass. The build passes, and so do the chunk-boundary checks.
- vitest: 2458 passed, 1 failed, 35 skipped. The failure is the pre-existing root-only
  `objects.test.ts` permission case, which is unrelated.

## New tests

All of these fail on the pre-change `ProgressiveRenderer` and pass after it.

- **Demand-loop start at 60 Hz** for Lite, High and Ultra.
- **Lite budget profile:** renderScale 0.5, 4 bounces, 128 spp.
- **Decoded textures** are kept before the session is constructed and released on unmount.
- **Probe vs texture changes:** a probe change neither halts nor invalidates the trace; a texture change does both.
- **Shader warm-up gates the first frame and `onReady`.**

Other new tests:

- `pathtrace.test.ts`: `LONG_MILESTONES` double past the rest and never fall inside the export target.
- `StageToolbarView.test.tsx`: intent fires on pointer and focus, but not while the view is open.
- `boundary.test.ts`: `liveIntent.ts` reaches `LiveDesignScene` only dynamically.

## Not verified (needs a real GPU)

- Time to first pixel and to the first refined image.
- Exposure match against the gallery image at 6 bounces.
- Lite's half-scale trace sharpness.
- The textured surfaces fix, verified visually.

The check is the Vercel preview with `?experience=library&bench=1`.

## F1 status

F1 (Lite never starts tracing) is fixed by b97f317.
