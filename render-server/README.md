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

The public endpoint is a **CPU-only PIN gateway**, not the GPU. A correct PIN creates a signed,
one-hour bearer session, held in browser memory (refreshing requires the PIN again). Authenticated
render/blob requests invoke a private Modal method. `/health` checks only the gateway and never
starts a GPU. There is no public GPU URL to bypass the gate. The PIN is not bundled into the site.

1. Create a Modal account, add billing, and configure the workspace spending controls. Pricing
   is approximately $1.95 per L40S GPU-hour **plus CPU/RAM and idle time**. A single GPU and rate
   limits do not enforce a dollar budget. Do not leave a test deployment running without approval.
2. Install `modal==1.1.4` with Python 3.11 and authenticate using `modal setup` or the
   `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` environment variables.
3. In Modal, create a secret named `fury-render-auth` containing:
   - `FURY_PIN_HASH`: scrypt hash of the desired PIN, generated below.
   - `FURY_SESSION_KEY`: at least 32 random characters (e.g. `secrets.token_hex(32)`).
     Use the Modal dashboard's secret fields; never commit these values or put them in Vite variables.

   ```sh
   cd render-server
   python -c 'import getpass, hashlib; print(hashlib.scrypt(getpass.getpass("PIN: ").encode(), salt=b"fury-render-pin-v1", n=16384, r=8, p=1).hex())'
   python -c 'import secrets; print(secrets.token_hex(32))'
   ```

4. Deploy with **explicit allowed origins** (none are allowed by default at the gateway):

   ```sh
   FURY_ALLOWED_ORIGINS='^https://your-preview\.vercel\.app$' modal deploy modal_app.py
   ```

   Set `VITE_CLOUD_RENDER_URL` to the printed **gateway** URL on the intended Vercel **preview
   branch only**, then build/deploy that preview. Do not enable production until tested and approved.
   No cloud URL means the existing local-only experience. `?cloud=0` also disables cloud rendering;
   it can bypass the front-end screen, but cannot bypass server authorization for paid rendering.
   This is GPU access control, **not** protection for the public static site or its assets.

5. Enter the PIN in the front-end screen. All uploads/renders carry only the signed session token.
   Incorrect/expired tokens receive 401 and cannot wake the GPU. Expiry prompts for the PIN again.

Settings read during deployment:

| Variable               | Default            | Effect                                            |
| ---------------------- | ------------------ | ------------------------------------------------- |
| `FURY_APP_NAME`        | `fury-render`      | Use a separate name for preview/test deployments  |
| `FURY_AUTH_SECRET`     | `fury-render-auth` | Modal secret holding PIN hash and signing key     |
| `FURY_ALLOWED_ORIGINS` | No origins         | Fully anchored regex for approved browser origins |
| `FURY_GPU`             | `L40S`             | GPU type                                          |
| `FURY_IDLE_SECONDS`    | `300`              | GPU idle tail before scale-to-zero; billed time   |
| `FURY_DENOISE`         | `auto`             | `cpu` skips GPU denoising (it falls back anyway)  |

Stop a test with `modal app stop <app-name>` and confirm zero tasks with `modal app list`.
To revoke all issued sessions, rotate `FURY_SESSION_KEY` and redeploy. Changing only the PIN hash
does not invalidate existing sessions. Never raise gateway `max_containers` above 1 without
replacing the in-memory limits with shared durable counters.

## Limits and caveats

- One GPU container, one active Blender render, max 15 seconds of Cycles sampling per render.
  Scene preparation, denoising, cold starts, packing and idle time are additional billable work.
- Gateway: global 10 PIN attempts/minute (burst 5), 40 render requests/minute (burst 8),
  1 GiB of uploads/hour (burst 512 MiB). Missing-blob retries count as render requests. The
  render limit leaves room for the orbit views the browser pre-renders around a resting view
  (one at a time, on a session of its own, so the visitor's newer views never drop them).
- These token buckets are in-process and reset when the gateway restarts/scales down. They reduce
  abuse but are **not durable quotas or a hard budget**. Use a strong access code for public use;
  a short shared PIN is guessable and is suitable only for a controlled preview.
- Wire and expanded bodies are bounded: 32 MiB for scenes, 128 MiB for individual blobs.
  Texture URLs are never fetched by the server, preventing redirects/private-network SSRF.
- GPU failure falls back to local tracing where supported. WebGL retains the raster image.
- Rendered images stay gzip-compressed from the GPU method through the gateway to the browser
  (`fury_render/rpc.py`). At 1920×1200 that is about 4.9 MB instead of 18.4 MB raw. The browser
  asks for `"transfer": "file"`, which sends the image as a gzip file rather than with
  `Content-Encoding: gzip`, so it stays compressed in the browser's cache of orbit views too.
- A tiny 640×480/128-sample scene passed through the deployed PIN gateway to L40S/OptiX:
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
# Open the frontend with ?cloud=http://127.0.0.1:8787 (no PIN required for loopback).
.venv/bin/python -m pytest -q
```

Gateway tests use a fake private dispatcher and verify that locked/malformed/rate-limited requests
never invoke it. Server tests exercise real CPU Cycles renders, uploads, image packing, camera
reuse and material edits. They do not replace deployed GPU or browser tests.

## Code map

- `fury_render/gateway.py`: PIN verification, signed sessions, CORS and pre-GPU request limits.
- `modal_app.py`: CPU ASGI endpoint and private GPU RPC, persistent OptiX cache.
- `fury_render/api.py`: missing-blob protocol, cache, queue and superseded-view handling.
- `fury_render/worker.py`: isolated Blender process; only one render at a time.
- `fury_render/blender.py`: geometry/material/light conversion and Cycles/OIDN rendering.
- `fury_render/protocol.py`: binary formats, validation and bounded decompression.
