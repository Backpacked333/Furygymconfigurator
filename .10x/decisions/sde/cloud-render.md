# Cloud rendering of resting views

Status: implemented; awaiting a Modal account and deploy to measure on a GPU
Owner: SDE
Requested: after two rounds of local speedups, "path tracing still takes forever even on a decent
laptop", then "let's do the cloud GPU rendering". Owner decisions: Modal with an L40S GPU, and
switch the GPU off when idle (no paid warm hours).

## Findings

1. A laptop GPU running a compute-shader path tracer cannot reach 1024 spp at full resolution in
   seconds (trace-speed.md). Hardware ray tracing on a server GPU can: Blender's own benchmarks put
   an interior scene at 1080p and a few hundred samples at ~6-7 s on an RTX 4090 with OptiX, the
   class of an L40S. Adaptive sampling and OptiX/OIDN denoising cut that further.
2. Blender's `bpy` 4.5 wheel runs headless with Cycles on CUDA/OptiX and ships on PyPI. Modal
   documents it on L40S GPUs, bills per second ($0.000542/s ≈ $1.95/h for an L40S), scales to zero
   and has workspace budgets.
3. Calibrated in Cycles against three-gpu-pathtracer's conventions (local CPU renders):
   - emission and background radiance carry over 1:1;
   - a sun's strength is irradiance;
   - point and spot power is 4π × intensity;
   - area power is π × area × radiance.

   Spot cones: three.js fades over cos(a)..cos(a(1-p)); Cycles fades over cos(a) plus
   (1-cos a)·blend. With blend set to match the two endpoints, Cycles matched the browser's
   falloff within 0.1% at 10-39°. Cycles ignores material backface culling, which the browser
   tracer applies (except for shadow rays).

4. EXR decoding in JavaScript is slow at 1920×1200: DWAB takes 0.8 s (0.54 MB), ZIP 0.22 s
   (2.8 MB). Half floats with a per-row delta, split into byte planes and gzip-compressed (3.0 MB),
   decode in about 50 ms, because the browser inflates the gzip natively.

## Decisions

1. **Blender Cycles on Modal** (`render-server/`).
   - One L40S at most, switched off after 5 idle minutes. OptiX kernel caches are kept on a volume.
   - Blender runs in a child process that owns `bpy`, behind a FastAPI server.
   - Scenes are kept in the browser's Y-up frame; only the sky lookup is rotated.
2. **A custom scene transport, not glTF.**
   - The browser sends the description of its prepared path-trace scene as JSON.
   - Bulky data (geometry, instance matrices, sky, texture files) goes as content-hashed blobs,
     uploaded only when the server answers 409, so material edits and camera moves send only
     JSON.
   - Textures served by the site are fetched by the server.
   - Instancing uses geometry nodes with per-point 4×4 matrices; 6,500 instances build in 14 ms.
   - Why not glTF: three's GLTFExporter needs plain materials, which would lose the path-trace
     overrides, and re-uploading a whole GLB on each edit would be slow.
3. **Same finishing as local traces.** The server returns linear HDR, and the browser applies
   its exposure match, bloom, vignette and tone mapping, so the handover stays consistent.
4. **Hybrid session** (`src/render/session.ts`).
   - If the cloud answered in the last 4 minutes, it gets a 6 s head start before the local
     tracer starts. Otherwise the local tracer starts at once and the cloud image crossfades over
     whatever it reached.
   - On a cloud failure, tracing continues locally.
   - Lite devices and WebGL-only browsers leave tracing to the cloud, which gives them path
     traced views for the first time.
5. **Abuse and cost limits.** A session's superseded requests are dropped before rendering,
   there is a 15 s render time limit, plus per-client rate limits, CORS restricted to the
   project's origins, and the Modal workspace budget as a hard cap.

## Rejected

- **Running the same WebGPU tracer in headless Chrome on a server GPU.** It would look
  identical, but it is compute-only (no RT cores), so it is several times slower than OptiX,
  and Chrome WebGPU on Linux NVIDIA containers is fragile.
- **Streaming the viewport as video (pixel streaming).** It needs an always-on GPU per visitor;
  the app only needs stills of resting views.
- **DWA-compressed OpenEXR responses.** Smaller (0.5 MB), but 0.8 s to decode in JavaScript.
- **Pre-warming the GPU on page load.** The first resting view already requests a render at load,
  which starts the container just as early.

## Verification

- `render-server/tests` (pytest, CPU Cycles), 8 tests:
  - the upload protocol (409, then upload, then render);
  - image content (sky and lit floor);
  - camera-only re-render with under 200 ms of scene work;
  - material edits;
  - superseded requests;
  - malformed requests;
  - lossless packing.
- Vitest, 15 tests:
  - blob encoders (geometry, instances, sky);
  - decoding an image packed by the Python server (contract fixture);
  - camera field of view;
  - server URL rules;
  - the hybrid session's handover and fallback logic.
- In the full app, in Chromium with the WebGL 2 backend, against a local CPU server: the first
  view uploaded its blobs after a 409 and rendered 930×627 in 19 s. An orbit then re-rendered
  with 3 ms of scene sync and no uploads, and the status read "Path traced".
- **Not verified:** GPU render times, cold-start time, and OptiX kernel caching. All three need
  the owner's Modal deploy.

## Follow-up: review of PR #11 (PIN gateway)

PR #11 put a CPU-only PIN gateway in front of the GPU and called the renderer through a private
Modal method. Two of its changes cost seconds per view; both measured on the merged code.

1. **Images were inflated in transit.** The method read the renderer's response with httpx,
   which decodes `Content-Encoding: gzip`, and the gateway sent the result on uncompressed. A
   1920×1200 view crossed as 18.4 MB instead of 4.9 MB. `fury_render/rpc.py` now passes the raw,
   still-compressed body and its encoding through. A gateway test checks the wire length.
2. **Denoising moved to the CPU.** The OptiX denoiser fails on Modal, so PR #11 switched to
   OIDN, but also turned off OIDN's GPU mode. On 4 vCPUs, OIDN with the accurate prefilter took
   about 12.5 s per 1920×1200 frame.
   - The renderer now runs OIDN on the GPU (it uses its own CUDA kernels, not OptiX).
   - If that fails at warm-up, fails to start, or crashes mid-render, it falls back to CPU
     denoising with the fast prefilter (about 3.5 s on the same machine).
   - `FURY_DENOISE=cpu` forces the CPU; `/health`, `X-Denoise`, and `?traceStats=1` report which
     path is in use.
   - **Not verified:** GPU denoising on Modal needs a deploy to confirm.

Raised with the owner, not changed:

- The PIN screen gates the whole configurator whenever `VITE_CLOUD_RENDER_URL` is set.
- An expired session replaces the app with the PIN screen.
- The global render limit is 12 a minute (burst 3), counting missing-blob retries.
- A short PIN can be brute-forced at 10 attempts a minute.

## Follow-up: orbit views without re-rendering

Asked: "how can we reach maximum resolution when everything is traced and you move it around and
it doesn't need to rerun and retrace everything every slight movement". A path-traced image is
only valid from the exact camera pose it was rendered for, so the options were: (A) more GPUs per
render, (B) pre-render the views around the resting one, or (C) reproject the traced image while
moving. Owner chose **B**.

1. **Resting views sit on a grid** (`src/render/orbit.ts`): 48 azimuths (7.5°), elevation steps
   of 5°, and zoom steps of 6% between OrbitControls' limits. When the exterior camera comes to
   rest it eases onto the nearest pose over 280 ms (at most 3.75° of azimuth, 2.5° of elevation,
   or 3% of zoom). A small deliberate move (an arrow key, a short drag) always advances at least
   one step instead of snapping back. Framing moves land exactly on a pose. Snapping applies only
   with a cloud renderer, in the exterior view, and not while auto-rotating.
2. **The ring around a resting view is pre-rendered** (`CloudSession` in `src/render/cloud.ts`).
   - Once the visitor's view is on screen, the other 47 azimuths at the same elevation and zoom
     render one at a time, nearest first, at the same resolution (full device pixels, up to
     3200 px on the long edge).
   - Pre-renders use their own server session, so a newer view from the visitor never supersedes
     them and they never supersede it. The visitor's own view goes first: pre-rendering waits
     while it is in flight, and a view that is being pre-rendered is joined, not rendered twice.
   - Views are keyed by design signature, orbit target, elevation, zoom, field of view, and image
     size. A design edit stops the ring, since its views would show the old design.
   - Pre-rendering pauses while the tab is hidden or after 3 minutes without input, and stops
     after three failures in a row.
3. **Images stay compressed in the browser.** The client asks for `"transfer": "file"`: the server
   returns the packed image as a gzip file instead of gzip transfer encoding, which the browser
   would inflate (a 1920×1200 view is about 18 MB inflated). A memory cache of 320 MB keeps about
   60 views; decoding one takes about 50 ms.
4. **A cached view never starts the local tracer**, even after the GPU has switched off.
5. The gateway's render limit went from 12 a minute (burst 3) to 40 (burst 8), so a visitor plus
   their pre-renders fit.

Rejected for now:

- **A (several GPUs per container):** Cycles can split one image across devices, but the
  scaling is sub-linear and it multiplies the hourly cost. It does not help movement at all.
- **C (reprojection while moving):** warping the traced image to nearby poses with a depth
  buffer shows disocclusion holes and wrong reflections, and the image still has to be
  re-rendered when the camera stops.
- **Pre-rendering every elevation and zoom:** 48 × 16 × 46 poses. One ring around where the
  visitor actually is covers the common case (orbiting sideways).

Cost: a full ring is 47 extra renders while the visitor is active, estimated at a few seconds
each on the L40S; not yet measured there.

Verification:

- Vitest: grid round trips, nearest and nudged snapping, azimuth wrap-around, OrbitControls'
  camera matrix, ring order, ring keys, LRU cache, gzip-file decoding, and that a cached view
  never starts the local tracer.
- pytest: the `"transfer": "file"` response is a gzip file without `Content-Encoding`, smaller
  than the inflated one, and decodes to the same image; the gateway throttle at the new burst.
- Full app (Chromium, WebGL 2 on a software GPU, local CPU render server, 550×427):
  - The first view rested on grid pose 4/15/23 and rendered in 16 s.
  - The ring started at once, nearest azimuths first, as gzip files of about 1.0 MB.
  - One arrow-key press later the camera rested on pose 5/15/23, which was already rendered. It
    was shown from the cache with no render request, and the badge read "4/48 angles ready".
- The first browser run found a bug that predates this work. `motionPixels` measured rotation
  as `acos(q·q')`, and a unit quaternion's dot with itself can round to just under 1 (17 of 48
  test orientations). A camera at rest then read as a sliver of motion every frame, so the snap
  never started and `settleGlide` kept requesting frames. An unmoved camera now reads as exactly
  still.
- **Not measured:** time from rest to a cached view on a real GPU. On the software GPU it was
  10.3 s: decoding took 31 ms and the exposure match 10.2 s. The match reads back a 48×30 frame
  behind a fence that waits for every queued GPU command, and each queued raster frame takes
  about a second there. On a real GPU that is a frame or two. `?traceStats=1` logs both times
  for each pre-rendered view.

## Follow-up: PIN removed

The owner asked to remove the PIN page so the configurator always opens. The PIN screen, the
browser's session token, and the gateway's `/auth` endpoint and token check are gone, along with
the `fury-render-auth` Modal secret.

- **What still protects the GPU:** CORS limited to the configured origins, request validation, a
  15 s render cap, and global rate limits of 40 renders a minute (burst 8) and 1 GiB of uploads
  an hour.
- **Cost risk:** these limits are in-process, and a script that ignores CORS can still use them up.
  The Modal workspace spending limit is the hard cap.
- **If the gateway can't be reached:** the browser traces on its own GPU, as it did before.

## Follow-up: measured on the deployed L40S

The owner asked for much faster renders at the same quality or better. Measured on the deployed
L40S with the real default view (1200×827), replayed through the gateway:

| Setting                                      | Cycles render | Error vs reference (RMSE/255) |
| -------------------------------------------- | ------------- | ----------------------------- |
| Current: ≤1024 samples, noise threshold 0.01 | 14.0 s        | 0.98                          |
| Threshold 0.02                               | 7.4 s         | 1.74                          |
| Threshold 0.05                               | 3.1 s         | 2.54                          |
| 64 samples, no threshold                     | 1.5 s         | 2.41                          |
| 256 samples, no threshold                    | 5.3 s         | 1.35                          |

- The reference used 4096 samples at threshold 0.002 and hit the 15 s cap.
- GPU denoising works on Modal (`X-Denoise: gpu`). Scene sync takes 2 ms when only the camera
  moves. Packing takes about 0.3 s, and the trip back through the gateway about 1 s.
- **A first visit uploads 24.5 MB of scene data, which took about 15 s.** The renderer kept it in
  container-local `/tmp`, so every cold start uploaded it all again.
- **Loosening the noise threshold costs quality measurably,** so it is not a way to go faster at
  equal quality. At viewing size, the 64-sample denoised image is hard to tell from the final.

Changes:

1. **A quick preview, then the final image.** For each new view the browser also asks for a
   64-sample preview. It shows that in about 2 s, then crossfades to the full image. Exports and
   the "Path traced" badge wait for the final image. If the final render fails, the preview stays.
2. **The visitor goes first.** The renderer's queue orders waiting renders by kind: preview, then
   view, then orbit pre-render. A render already running is never interrupted.
3. **Scene data persists.** Blobs live on the Modal volume (`/fury-cache/blobs`), which commits in
   the background, so a container starting cold already has them. The store lists its directory
   only when it is over budget, not on every upload, because a volume is a network filesystem.
4. Concurrent renders share uploads, so a preview and its view never upload the same blob twice.

More GPUs per container (`FURY_GPU=L40S:4`) would cut the 14 s roughly in proportion; not measured.
