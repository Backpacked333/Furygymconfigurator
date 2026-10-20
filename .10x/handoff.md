# Handoff

**Context.** This was a discovery deep-dive of main-branch, with emphasis on the live 360° view. No product code was changed.

## Read first

- `decisions/cto/platform-overview.md`: the two experiences, the stack and the risks.
- `decisions/architect/live-360-viewer.md`: the full 360° design, covering both the library and legacy implementations.
- `decisions/qa/live-360-viewer.md`: findings F1 and F2.

## Open items for the next role

1. **F1 (SDE).**
   - Change the start condition in `src/viewer/ProgressiveRenderer.tsx` (lines 200, 218, 231) so that Lite (`settleFrames=1`) starts tracing under the R3F demand loop.
   - Add a demand-loop test. The current test calls frames unconditionally, so it misses the bug.
   - Product question: should phones path-trace at all? If not, report `raster-only` explicitly on Lite.
2. **F2 (SDE/UX).** In live mode, the `GraphicsBoundary` button reads "Open the floor plan". Give it a live-mode label or auto-report unavailability. Verify the behavior in a browser.
3. **Test environment (QA).** `objects.test.ts` should skip its permission case when running as root, or CI should guarantee a non-root user.
4. **CTO/PM.** Decide whether to retire the v3 route or keep two configurators. The README configuration section documents only v3.

## How to verify

- Run `npm ci`, then `npm run typecheck && npm run lint && npx vitest run`. The full suite takes about 5 min.
- WebGPU pixels need a real GPU. Headless Chromium here can only use SwiftShader offscreen (see the earlier notes in `decisions/sde/trace-speed.md`).
