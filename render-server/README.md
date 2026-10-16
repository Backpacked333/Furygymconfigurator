# Cloud renderer

Optional Blender Cycles renderer for the configurator. An L40S uses OptiX hardware ray tracing,
and Open Image Denoise (OIDN) finishes the image on the GPU. OptiX's own denoiser fails on the
tested Modal runtime even though OptiX rendering works, so OIDN is used instead.

If GPU denoising fails, the renderer falls back to CPU denoising by itself. That covers failing
at warm-up, failing to start, or crashing mid-render. The CPU path uses OIDN's fast prefilter:
about 3.5 s at 1920×1200 on 4 vCPUs, against 12.5 s with the accurate one. `/health`, the
`X-Denoise` header, and the browser's `?traceStats=1` log say which is in use. The browser
applies exposure matching, bloom, and tone mapping.

## Access and deployment

The public endpoint is a **CPU-only gateway**, not the GPU. It validates and rate-limits render
and blob requests, then invokes a private Modal method. `/health` checks only the gateway and never
starts a GPU. There is no PIN: browsers on the allowed origins render directly. Anyone who can
reach the gateway URL can request renders, so the Modal spending limit is the real cost cap.

1. Create a Modal account, add billing, and configure the workspace spending controls. Pricing
   is approximately $1.95 per L40S GPU-hour **plus CPU/RAM and idle time**. A single GPU and rate
   limits do not enforce a dollar budget. Do not leave a test deployment running without approval.
2. Install `modal==1.1.4` with Python 3.11 and authenticate using `modal setup` or the
   `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` environment variables.
3. Deploy with **explicit allowed origins** (none are allowed by default at the gateway). Every
   Vercel deployment has its own URL besides the branch URL; a pattern like this one covers all
   of a project's preview URLs:

   ```sh
   cd render-server
   FURY_ALLOWED_ORIGINS='^https://<project>(-[a-z0-9-]+)?-<team-slug>\.vercel\.app$' modal deploy modal_app.py
   ```

   Set `VITE_CLOUD_RENDER_URL` to the printed **gateway** URL on the intended Vercel **preview
   branch only**, then build/deploy that preview. Do not enable production until tested and approved.
   No cloud URL means the existing local-only experience. `?cloud=0` also disables cloud rendering.
   If the gateway can't be reached, the browser traces on its own GPU instead.

Settings read during deployment:

| Variable               | Default       | Effect                                            |
| ---------------------- | ------------- | ------------------------------------------------- |
| `FURY_APP_NAME`        | `fury-render` | Use a separate name for preview/test deployments  |
| `FURY_ALLOWED_ORIGINS` | No origins    | Fully anchored regex for approved browser origins |
| `FURY_GPU`             | `L40S`        | GPU type                                          |
| `FURY_IDLE_SECONDS`    | `300`         | GPU idle tail before scale-to-zero; billed time   |
| `FURY_DENOISE`         | `auto`        | `cpu` skips GPU denoising (it falls back anyway)  |

Stop a test with `modal app stop <app-name>` and confirm zero tasks with `modal app list`.
Never raise gateway `max_containers` above 1 without replacing the in-memory limits with shared
durable counters.

## Limits and caveats

- One GPU container, one active Blender render, max 15 seconds of Cycles sampling per render.
  Scene preparation, denoising, cold starts, packing and idle time are additional billable work.
- Gateway: global 40 render requests/minute (burst 8), 1 GiB of uploads/hour (burst 512 MiB). Missing-blob retries count as render requests. The
  render limit leaves room for the orbit views the browser pre-renders around a resting view
  (one at a time, on a session of its own, so the visitor's newer views never drop them).
- These token buckets are in-process and reset when the gateway restarts/scales down. They reduce
  abuse but are **not durable quotas or a hard budget**. With no PIN, a script that ignores CORS
  could keep the GPU busy up to these limits; the Modal workspace spending limit caps the cost.
- Wire and expanded bodies are bounded: 32 MiB for scenes, 128 MiB for individual blobs.
  Texture URLs are never fetched by the server, preventing redirects/private-network SSRF.
- GPU failure falls back to local tracing where supported. WebGL retains the raster image.
- Rendered images stay gzip-compressed from the GPU method through the gateway to the browser
  (`fury_render/rpc.py`). At 1920×1200 that is about 4.9 MB instead of 18.4 MB raw. The browser
  asks for `"transfer": "file"`, which sends the image as a gzip file rather than with
  `Content-Encoding: gzip`, so it stays compressed in the browser's cache of orbit views too.
- A tiny 640×480/128-sample scene passed through the deployed gateway (then PIN-gated) to L40S/OptiX:
  660 ms rendering, 1.85 s HTTP round trip with a warm worker after blob uploads. That run
  predates GPU denoising and compressed transfer. It is not a full configurator benchmark:
  verify actual scenes, GPU denoising, and cold starts before launch.

## Local development and tests

The local server is intentionally unauthenticated and binds only to loopback. Do not expose it.

```sh
cd render-server
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest
.venv/bin/python -m fury_render.local --device cpu
# Open the frontend with ?cloud=http://127.0.0.1:8787.
.venv/bin/python -m pytest -q
```

Gateway tests use a fake private dispatcher and verify that locked/malformed/rate-limited requests
never invoke it. Server tests exercise real CPU Cycles renders, uploads, image packing, camera
reuse and material edits. They do not replace deployed GPU or browser tests.

## Code map

- `fury_render/gateway.py`: CORS, request validation and pre-GPU request limits.
- `modal_app.py`: CPU ASGI endpoint and private GPU RPC, persistent OptiX cache.
- `fury_render/api.py`: missing-blob protocol, cache, queue and superseded-view handling.
- `fury_render/worker.py`: isolated Blender process; only one render at a time.
- `fury_render/blender.py`: geometry/material/light conversion and Cycles/OIDN rendering.
- `fury_render/protocol.py`: binary formats, validation and bounded decompression.
