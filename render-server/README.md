# Cloud renderer

Renders the configurator's resting views on a cloud GPU with Blender Cycles (hardware ray tracing
through OptiX, GPU denoising). The browser sends the path-traced form of its scene; this server
renders it and sends back a linear HDR image. The browser then applies its usual exposure match,
bloom and tone mapping. See `src/render/cloud.ts` for the browser side and the README's
"Cloud rendering" section for how the two fit together.

## Deploy on Modal

The configuration in `modal_app.py`:

- one L40S GPU at most;
- the GPU switches off after five idle minutes, so you pay only while visitors look at renders;
- compiled GPU kernels kept on a Modal volume, so later cold starts don't recompile them.

1. Create an account at [modal.com](https://modal.com). Under **Settings → Usage and billing**,
   set a **workspace budget** (a monthly spending cap). One GPU is about $1.95 an hour while it
   is on.
2. Install the CLI and sign in (Python 3.11 or newer):

   ```sh
   pip install modal
   modal setup
   ```

3. Deploy from this directory:

   ```sh
   cd render-server
   modal deploy modal_app.py
   ```

   The first deploy builds the image, which takes a few minutes. It prints the endpoint's URL,
   like `https://<workspace>--fury-render-renderer-web.modal.run`.

4. In the Vercel project, add the environment variable `VITE_CLOUD_RENDER_URL` with that URL (for
   Production and Preview), then redeploy the site. Without the variable the site path traces on
   the visitor's GPU only, as before.

By default, browsers may call the server from the project's Vercel deployments
(`furygymconfigurator*.vercel.app`) and from `localhost`. To allow a custom domain, deploy with
`FURY_ALLOWED_ORIGINS` set to a regular expression of the allowed origins, for example:

```sh
FURY_ALLOWED_ORIGINS='^https://(www\.)?example\.com$|^https://furygymconfigurator[a-z0-9-]*\.vercel\.app$' modal deploy modal_app.py
```

Other settings, read when deploying:

| Variable            | Default | Effect                                          |
| ------------------- | ------- | ----------------------------------------------- |
| `FURY_GPU`          | `L40S`  | Modal GPU type (`L4` is cheaper and ~3× slower) |
| `FURY_IDLE_SECONDS` | `300`   | Idle time before the GPU is switched off        |

To keep a GPU on during business hours, add `min_containers=1` to the `@app.cls` decorator in
`modal_app.py`, or schedule it from Modal's dashboard. That makes every render instant, but you
pay for the GPU for all of those hours.

## Run locally

Rendering on the CPU is slow (tens of seconds a view) but needs no account, and it's useful for
development:

```sh
cd render-server
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m fury_render.local --device cpu      # http://127.0.0.1:8787
```

Then open the app with `?cloud=http://127.0.0.1:8787`.

Tests render small scenes on the CPU:

```sh
.venv/bin/pip install pytest
.venv/bin/python -m pytest
```

## How it works

- `fury_render/api.py`: the HTTP API (`/health`, `PUT /blobs/{sha256}`, `POST /render`).
  - Blobs are cached on disk by content hash. A render whose blobs are missing answers 409 with
    their hashes, and the browser uploads just those. Textures the site itself serves are fetched
    by the server instead.
  - Requests from one session that a newer view has replaced are dropped before rendering.
  - Rate limits apply per client.
- `fury_render/worker.py`: Blender runs in a child process that owns `bpy`, one render at a time.
- `fury_render/blender.py`: builds and updates the Cycles scene and renders.
  - Meshes, images and materials are cached by content, and Cycles keeps its scene between
    renders (persistent data), so a new camera angle starts rendering at once.
  - Light units were calibrated against the browser's path tracer: emission and sky radiance
    carry over as is, a sun's strength is its irradiance, point and spot lights emit 4π W per
    W/sr, and area lights emit π·area W per unit of radiance.
  - One-sided materials are transparent from behind except to shadow rays, as in the browser's
    tracer.
- `fury_render/protocol.py`: the binary formats and request limits.
