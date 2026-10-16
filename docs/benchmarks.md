# Rendering benchmarks

Numbers the configurator's rendering decisions rest on. Rows marked _estimate_ have not been
measured on that hardware; replace them as measurements come in. Open the app with `?bench=1`
to get the on-screen panel (and `?traceStats=1` for the console log it summarizes).

## What the panel reports

| Field                 | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| first raster frame    | From page load until the live WebGPU view first drew                          |
| first preview         | Until the first path-traced preview of the view on screen (cloud or local)    |
| first good frame      | Until the rested view's 256-sample frame                                      |
| cloud state           | `cold` (container started for this page), `warm`, `full`, `off`, `failed`     |
| per-frame server time | Median render / finish / round-trip ms from the server's `X-Render-*` headers |
| local tracer          | Time to the first denoised image and to settled, per view (`?traceStats=1`)   |

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
