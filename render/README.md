# Still renderer

Renders the configurator's pre-rendered still layers offline and publishes them as static files.
The app shows these stills first and loads the live 3D (the 360 view) only on demand.

## How stills are built

- Seven angles per configuration (`src/lib/cameras.ts`): five exterior, two interior. Each angle
  uses a fixed camera for each product and size, so changing an option crossfades between stills
  without the camera moving.
- Front-facing exterior angles see the room through the Studio glazing or the Container opening.
  They are two layers: a **shell** (the exterior, with alpha where the room shows and glass keeping
  its reflection) over an **interior** (the room). The browser stacks them. Every other angle is
  one **full** image.
- `src/lib/stills.ts` lists every layer any configuration can need, about 56,800 in total. Each
  key hashes only the inputs that layer can show, plus `RENDERER_ID` and `SCENE_VERSION`
  (`src/lib/renderKey.ts`).
- The worker opens the app's `?render` harness in headless Chromium. It waits for textures, the
  ground and the interior probe, then accumulates 256 frames at Ultra quality at 1.5× resolution.
  It also captures two mattes (the room filled with black, then grey) whose difference gives
  the shell's alpha.
- Each layer is downscaled to 640, 1024 and 2048 px wide and encoded as AVIF and WebP.

## Running a batch

Build the app first (`npm run build` in the repository root), then from `render/`:

```sh
npm ci
npm run count                                   # layers per angle and kind
npm run batch -- --out out --limit 20           # local folder
npm run batch -- --r2 --shard 0/4 --pages 3     # Cloudflare R2, one of four machines
npm run verify -- --r2                          # check everything is there, mark it ready
```

R2 needs `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`. The app reads
stills from `VITE_STILLS_BASE`, the bucket's public custom domain. Batches skip layers that are
already published, so an interrupted run resumes where it stopped.

The renderer refuses software and WebGL adapters for published stills. To smoke-test on a machine
without a GPU, add `--allow-fallback --webgl --quality lite --frames 2 --width 640 --scale 1`.

### GPU host

Use a full VM with an NVIDIA GPU and the Vulkan driver capability, for example a GCP
`g2-standard-8` (L4, 24 GB). Headless Chromium needs Vulkan for WebGPU, which serverless GPU
platforms often don't expose.

```sh
docker build -f render/Dockerfile -t fury-stills .
docker run --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all -e R2_ACCOUNT_ID -e R2_ACCESS_KEY_ID \
  -e R2_SECRET_ACCESS_KEY -e R2_BUCKET fury-stills npm run batch -- --r2 --pages 3 --shard 0/4
```

A full batch is roughly 55–60k jobs. Measure seconds per job on your GPU with `--limit 50` before
scaling out with `--shard`.

## Releasing a visual change

1. Change the scene, then bump `SCENE_VERSION` in `src/lib/renderKey.ts`.
2. Run `npm run scene-version:accept` in the root. CI's `scene-version` check fails if render
   inputs change without this step.
3. Run the batch and the audits, then `npm run verify -- --r2`. The verifier writes
   `ready-scene-<version>.json`. Until it exists, the app renders stills live, so a deploy that is
   ahead of its batch never shows a broken image.
4. Deploy.

## Audits

- `npm run audit:seams` renders sample configurations both as one image and as stacked layers,
  and fails if they differ by more than 40 dB PSNR, overall or at the glass edges.
- `npm run audit:relevance` renders sample layers from the real configuration and from the
  representative the batch uses, and fails if a key leaves out something visible.

## Later: Blender Cycles

`src/renderers/cycles.ts` reserves the same `StillRenderer` interface for path-traced stills once
CAD-derived models exist. Its own renderer id keys a separate set of stills.
