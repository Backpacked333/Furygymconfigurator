# Cloud renderer

Optional Blender Cycles renderer for the configurator. An L40S uses OptiX hardware ray tracing,
and Open Image Denoise (OIDN) finishes the image on the GPU. OptiX's own denoiser fails on the
tested Modal runtime even though OptiX rendering works, so OIDN is used instead.

If GPU denoising fails, the renderer falls back to CPU denoising by itself. That covers failing
at warm-up, failing to start, or crashing mid-render. The CPU path uses OIDN's fast prefilter:
about 3.5 s at 1920×1200 on 4 vCPUs, against 12.5 s with the accurate one. `/health`, the
`X-Denoise` header, and the browser's `?traceStats=1` log say which is in use. The browser
applies exposure matching, bloom, and tone mapping to views; the path-traced spin's frames are
finished here instead (`fury_render/finishing.py`: the browser's exposure gain, bloom, AgX tone
mapping and dither) and sent as WebP.

## Access and deployment

The public endpoint is a **CPU-only gateway**, not the GPU. It validates and rate-limits render
and blob requests, then invokes a private Modal method. `/health` checks only the gateway and never
starts a GPU. There is no PIN: browsers on the allowed origins render directly. Anyone who can
reach the gateway URL can request renders, so the Modal spending limit is the real cost cap.

**One GPU per render session.** Each page names its render session in a `session` query
parameter on every render and upload (one id per page load, `src/render/cloud.ts`). A query
parameter needs no CORS preflight, so pages and gateways from before sessions keep working with
each other in either order of deployment. The renderer is a
parametrized Modal class, `Renderer(session=...)`: each session is a Modal function of its own,
with its own container holding one L40S, its own Blender process and its own queue. At most
`FURY_MAX_SESSIONS` sessions (default 3) hold a GPU at once; a session keeps its place until a
minute after its GPU would have gone idle and off (`FURY_IDLE_SECONDS` + 60 s after its renderer
last answered), so no more GPUs than places are ever on. The places live in the gateway
container's memory, so it stays up that long after its last request too (`modal_app.py`): a
gateway starting afresh would admit new sessions beside GPUs still on. A new session beyond the
limit gets `503 {"full": true}` without starting a GPU, and its page traces on the visitor's own
device. A page that names no session (one older than sessions) shares one.

**Warm starts.** A container starting cold takes 30 to 90 seconds (importing bpy, the OptiX
kernel cache, OIDN warm-up), most of a visitor's wait, and at the old one-minute idle tail most
visits were cold. Three things shorten it:

- Each session's GPU stays on for `FURY_IDLE_SECONDS` (default 600) after its last request, so a
  visitor who reloads or comes back within ten minutes starts warm. Idle time is billed.
- `GET /warm?session=<id>` takes the session's place under the cap exactly as a render would
  (`503 {"full": true}` when every place is taken; a place it already has is refreshed) and asks
  its own renderer for `/health` in the background, which starts the container while the page is
  still loading textures; the place then runs from the renderer's answer, as the GPU's idle tail
  does. It answers `202 {"warming": true, "renderer": "own"}` at once, without waiting for the
  container, and is limited to 6 calls a minute per client. A container whose idle tail has
  passed is started again the same way. The gateway's own `/health` still never starts a GPU.
- `FURY_WARM=1` at deploy time keeps one extra renderer running at all times (`WarmRenderer`:
  one L40S billed around the clock, so off by default). A session's render and blob requests go
  there until its own renderer has answered (the `/warm` health call, or its first request
  without one), then to its own. That readiness lasts until a minute before its GPU's idle tail
  ends (`FURY_IDLE_SECONDS` − 60 s after its own renderer last answered): past that its
  container may be stopping, so requests go to the renderer kept running again while `/health`
  starts its own. At the handover a session's own renderer reloads the volume once, so the blobs
  its visitor uploaded to the renderer kept running meanwhile are there too (a blob not yet
  committed by then is asked for again, the 409 protocol). Every dispatched response says which
  answered in `X-Fury-Renderer: shared|own`, for the browser's bench panel. Without `FURY_WARM`
  the class scales to zero like any other, and every request goes to the session's own renderer;
  either way only the gateway's routing reaches it, as a request naming the session
  `shared-warm` is refused.

1. Create a Modal account, add billing, and configure the workspace spending controls. Pricing
   is approximately $1.95 per L40S GPU-hour for each visitor's container while it runs, so up to
   about $5.85 an hour with three visitors at once, **plus CPU/RAM and idle time**: each
   session's GPU stays on for `FURY_IDLE_SECONDS` (ten minutes) after its last request, and
   `FURY_WARM` adds one L40S around the clock. Scale-to-zero and rate limits do not enforce a
   dollar budget. Do not leave a test deployment running without approval.
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
| `FURY_GPU`             | `L40S`        | GPUs per session; one renderer per GPU            |
| `FURY_MAX_SESSIONS`    | `3`           | Render sessions holding a GPU at once             |
| `FURY_IDLE_SECONDS`    | `600`         | GPU idle tail before scale-to-zero; billed time   |
| `FURY_WARM`            | `0`           | `1` keeps one renderer running (one L40S, always) |
| `FURY_DENOISE`         | `auto`        | `cpu` skips GPU denoising (it falls back anyway)  |

Stop a test with `modal app stop <app-name>` and confirm zero tasks with `modal app list`.
Never raise gateway `max_containers` above 1 without replacing the in-memory limits and the
session registry with shared durable counters.

## Limits and caveats

- Scene data (geometry, textures, sky) is stored on the `fury-render-cache` volume, shared by every
  visitor and kept across cold starts, so the browser uploads a design's data only once.
- One container with one L40S for each render session. A container's GPUs are on one machine,
  and Modal warns that more than two per container usually means longer waits: an eight-L40S
  container stayed "scheduling" for over ten minutes, while a single L40S schedules in seconds.
  `FURY_GPU=L40S:2` gives each session two, with a Blender process on each (`FURY_WORKERS`)
  rendering whole frames side by side. A session's container reads the blobs and frames other
  sessions had committed to the volume when it started; whatever its own visitor still lacks they
  upload to it (the 409 protocol), so no volume reload is needed except at a `FURY_WARM`
  handover (above). Each visitor's first request starts their container cold (see warm starts
  above). Max 15 seconds of Cycles sampling per view, 60 for a 360° panorama. Waiting renders go
  by priority: the visitor's frame, then the angles near it, then the rest; with `?spin=0`,
  previews, then views, then orbit pre-renders. A request may give an explicit `priority` of
  0–31 (lower first; the browser sends a frame's ring distance from the visitor's view). A
  session's queued request is dropped the moment the same session asks for a newer `seq`: it
  answers `409 {"superseded": true}` at once, without waiting for a worker, and its queue place
  is free again before the newer request asks for one, since a Cycles render in progress cannot
  be interrupted and stale work would otherwise hold a queue place until one is free. A request
  for an older `seq` arriving after the newer one is answered the same way and takes no place.
  Scene preparation, denoising, cold starts, finishing and idle time are additional billable
  work: finishing a frame (bloom, tone mapping, WebP) takes a few seconds of CPU at the
  panorama's 8192 × 4096, and frames being finished count toward the renderer's queue limit.
- Finished spin frames are kept on the volume (`/fury-cache/frames`, 4 GB, oldest pruned first)
  with their exposure reading, named by the SHA-256 of the scene, camera, size, quality and
  finish, plus the Blender version, denoiser (GPU or CPU) and `FINISHING_VERSION` that made
  them, so a change to any of those renders again instead of serving old frames. A design anyone
  has seen from that angle comes back without a render.
- Gateway: global 600 render requests/minute (burst 240), 1 GiB of uploads/hour (burst 512 MiB),
  6 `/warm` calls a minute per client. Missing-blob retries count as render requests. The render limit leaves room for each visitor's
  spin: about five frame requests open at a time, a few hundred per design. A busy answer (429 or 503) makes the browser wait two seconds and ask again; a full one (`"full": true`) makes it
  render on its own device.
- The gateway waits up to 180 seconds for the GPU, then answers 503 and **cancels** the Modal
  call (`fury_render/rpc.py`). A plain `.remote()` call would stay queued: while the GPU
  container was still "scheduling", calls the gateway had given up on minutes earlier were still
  pending, waiting to be rendered for no one. A call cancelled mid-render still finishes on its
  GPU (Blender can't be interrupted), and the worker stays taken until it does. A finished spin
  frame still goes into the frame cache, so asking again gets it without another render.
- These token buckets and the session places are in-process and reset when the gateway restarts
  or scales down. The gateway scales down only `FURY_IDLE_SECONDS` + 60 s after its last request,
  so every GPU it admitted is off by then and the session cap holds across its restarts; a
  redeploy or a crash still starts it with no places taken. The buckets reduce abuse but are
  **not durable quotas or a hard budget**. With no PIN, a script that ignores CORS could keep the
  GPU busy up to these limits; the Modal workspace spending limit caps the cost.
- Wire and expanded bodies are bounded: 32 MiB for scenes, 128 MiB for individual blobs.
  Texture URLs are never fetched by the server, preventing redirects/private-network SSRF.
- GPU failure falls back to local tracing where supported. WebGL retains the raster image. The
  spin gives up after three failed frames in a row and does not try again on that page.
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

- `fury_render/gateway.py`: CORS, request validation, pre-GPU request limits, the render
  sessions with a GPU, `/warm` and the routing through the renderer kept running.
- `modal_app.py`: CPU ASGI endpoint and private GPU RPC (a renderer per session and the one
  kept running), persistent OptiX cache.
- `fury_render/rpc.py`: the private call, with compressed images kept compressed and abandoned
  calls cancelled.
- `fury_render/api.py`: missing-blob protocol, frame cache, priority queue over the workers and
  the early drop of superseded views.
- `fury_render/worker.py`: isolated Blender process, one per GPU; one render at a time each.
- `fury_render/finishing.py`: spin frames' exposure, bloom, AgX tone mapping, dither and WebP.
- `fury_render/blender.py`: geometry/material/light conversion and Cycles/OIDN rendering.
- `fury_render/protocol.py`: binary formats, validation and bounded decompression.
