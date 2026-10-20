# Live 360° speed and quality: implementation approach

- **Start gate.** Replace `remaining` with `drawn` (frames drawn since the last change), and start
  when `drawn >= START_FRAMES (6)` and `now >= restAt`. Request frames while
  `drawn < START_FRAMES || now < restAt` if no gate permanently blocks. Texture loading re-invalidates
  through `textureProgress`, so no polling is needed.
- **Probe listener.** `onMaterialsChanged(change)`:
  - for `'textures'`: mark dirty, invalidate the tracer and request a frame;
  - for `'probe'`: request a raster frame only when the view isn't tracing; otherwise do nothing.

  The trace capture re-reads the raster on its next start.

- **Decoded textures.** In the loader effect, `await keepDecodedTextures(true)` before
  `new PathTraceSession`. On cleanup, call `keepDecodedTextures(false)`, but only if this component
  enabled it.
- **Warm-up.** In the setup effect, run `Promise.race([pipe.warm(), timeout(1500)])`. While it is
  pending, the frame callback returns early (no `pipe.render()`), and `onReady` waits for it.
- **Fade length.** `FADE_MS` becomes the session field `this.fadeMs`.
