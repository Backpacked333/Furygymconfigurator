# Live 360° viewer — QA findings [2026-10-20]

## Baseline on main-branch @ 0d813f1

- typecheck: OK
- lint: OK
- vitest: 2449 passed, 1 failed, 35 skipped (170 files). The failing test is recorded in the review report.

## F1: Lite tier never starts path tracing at 60 Hz (CONFIRMED by probe test)

- **Where:** `src/viewer/ProgressiveRenderer.tsx:200,218,231`.
- **Cause:**
  - After a change, the viewer sets `remaining = max(6, settleFrames)`. Tracing starts only when `remaining <= settleFrames - 6`.
  - On Lite, `settleFrames = 1` (`render/pipeline.ts:171`), so tracing needs `remaining <= -5`: 11 raster frames.
  - The viewer only keeps frames coming (`invalidate()`) while `remaining > 0` or the 150 ms rest window is open. That is about 10 frames at 60 Hz.
  - In the R3F demand loop, frames then stop before the start condition is met.
- **Probe results** (demand loop: a frame runs only after an `invalidate`):

  | Tier                   | Frame interval | Frames run | Trace started |
  | ---------------------- | -------------- | ---------- | ------------- |
  | Lite (settleFrames 1)  | 16.7 ms        | 10         | No            |
  | Lite (settleFrames 1)  | 8.3 ms         | 20         | Yes           |
  | High (settleFrames 28) | 16.7 ms        | 10         | Yes           |

- **Impact:**
  - Lite is the default for viewports under 700 px wide (`render/quality.ts`), i.e. phones and narrow windows.
  - On those devices the 360° view stays at "interactive" raster and never refines, unless some unrelated invalidation happens to land later.
  - The existing unit test misses this because it drives frames unconditionally, with `settleFrames: 10`.
- **Suggested fix:**
  - Count frames drawn since the change, rather than comparing against `settleFrames - 6`.
  - Keep invalidating until the start condition can be evaluated true.
  - Add a demand-loop test for `settleFrames: 1`.

## F2: Live-mode graphics failure shows a mislabeled button (UNVERIFIED in browser)

- **Where:** `SceneSurface.tsx` `GraphicsBoundary`.
- **Behavior:** the fallback says "Open the floor plan". In live mode, `onFallback` is `LiveViewport.onUnavailable`, so clicking it marks the viewer unavailable; it does not open a plan.
- **Impact:** until the button is clicked, the "Preparing your live 360° view…" overlay also sits under the fallback.
- **Gap:** no test covers this path.

## Coverage gaps (per `src/viewer/README.md`)

- Lifecycle tests mock the GPU, so no rendered pixels are verified.
- Browser acceptance (both families, door add/remove, resize, WebGL fallback) and real-GPU convergence benchmarks are not automated.
