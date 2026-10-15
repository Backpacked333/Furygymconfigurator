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
