# Rendering benchmarks

Numbers the configurator's rendering decisions rest on. Rows marked _estimate_ have not been
measured on that hardware; replace them as measurements come in. Open the app with `?bench=1`
to get the on-screen panel (and `?traceStats=1` for the console log it summarizes).

## What the panel reports

Seconds are from page load (`performance.now()`); `—` is not yet. The store is
`src/render/bench.ts`, the table `BenchPanel` in `src/App.tsx`.

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| first raster frame | Until the live view first drew                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| first preview      | Until the first path-traced image of the view was on screen: a spin frame at any tier, or the local tracer's first denoised image                                                                                                                                                                                                                                                                                                                                                     |
| first good frame   | Until a frame of the spin's good tier or better (256 samples), or a local trace of 256 samples, was on screen                                                                                                                                                                                                                                                                                                                                                                         |
| first local trace  | Until the local tracer's first denoised image, when it ran at all                                                                                                                                                                                                                                                                                                                                                                                                                     |
| cloud              | `off` until the cloud first answered (or none is configured); `cold` when that first answer came from the shared renderer or took more than 8 s (the session's container started for this page); `warm` when it answered at once; `full` while every GPU is in use (the page renders on its own device and asks again in a minute); `failed` once the spin gave up. Then how many frames each renderer answered (`X-Fury-Renderer`: the session's `own` GPU or the `shared` warm one) |
| server frame       | Medians over the last 24 frames the server rendered (cache hits left out): its render time (`X-Render-Ms`), its finishing time (`X-Finish-Ms`: exposure, bloom, tone mapping, WebP), and the round trip as the browser saw it; then the frames answered in all, and how many came from the server's cache                                                                                                                                                                             |
| local tracer       | The local tracer's last view: seconds to its first denoised image, and to settled (every region finished); `?traceStats=1` logs the same per view                                                                                                                                                                                                                                                                                                                                     |

## Cloud (Modal, one L40S per session), 1200×827 exterior view

| Setting                              | Render | Source                        |
| ------------------------------------ | ------ | ----------------------------- |
| 64 samples, no threshold (preview)   | 1.5 s  | measured, PR 10               |
| 256 samples, no threshold (good)     | 5.3 s  | measured, PR 10               |
| 1024 samples, threshold 0.01 (final) | 14.0 s | measured, PR 10               |
| Cold start to first frame            | —      | _not measured_                |
| Volume frame-cache hit, round trip   | ~1 s   | measured (gateway hop), PR 10 |

## Local tracer (three-gpu-pathtracer + OIDN), device resolution

| Device                      | First denoised image           | 256 spp settled | Source                      |
| --------------------------- | ------------------------------ | --------------- | --------------------------- |
| Owner's desktop GPU         | —                              | —               | _not measured_              |
| MacBook (Apple silicon)     | —                              | —               | _not measured_              |
| Mid-range Windows laptop    | —                              | —               | _not measured_              |
| SwiftShader (CPU emulation) | 25–35 min to 16 spp at 320×200 | —               | measured, `.10x/handoff.md` |

## Decisions these numbers drive

- The preview tier is the displayed quality during exploration; the good tier replaces it when
  the view rests; the final tier is rendered only for photo mode and the PDF.
- If a consumer GPU reaches a clean 256-sample OIDN image in 3–4 s, the cloud becomes the
  showroom and export path rather than the default.
