# viewer360

A fast, product-agnostic 3D/360° viewer framework on three.js (WebGPU with a WebGL 2 fallback) and React Three Fiber. The Fury configurator is its first user (`src/components/Scene.tsx`). Any other product can import it and plug in its own scene.

The rule behind every choice: speed and reliability first, on the weakest device first. Extra quality is spent only where it costs no smoothness: at rest, after the camera stops, and on devices that have shown they are fast.

## Entry points

| Import               | Contents                                                                                                          | Loads three.js?           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `@fury/viewer360`    | Device detection, tiers, governor, adaptive-quality hook, progress stores, `whenIdle`, `preloadViewer`, `PerfHud` | No: safe in the app shell |
| `@fury/viewer360/3d` | Renderer, pipelines, shadows, `<Viewer>`, `<RenderLoop>`, `<OrbitRig>`, `<CubeProbe>`, `useTier`                  | Yes: load it lazily       |

The aliases are set in `vite.config.ts` and `tsconfig.json`. ESLint stops anything in `src/viewer/` from importing the product around it, so to reuse the framework you copy the folder and those two aliases. To publish it as a package, add a `package.json` with `three`, `react`, `@react-three/fiber` and `@react-three/drei` as peer dependencies.

## How it stays fast

- **The tier follows the device, not the screen** (`quality.ts`, `governor.ts`, `useAdaptiveQuality.ts`).
  - Lite on touch devices, ≤ 4 GB memory, ≤ 4 cores or Save-Data. High elsewhere. Ultra is never the default.
  - The governor watches real frames: motion frames slower than about 22 ms, or slow settles, step the tier down. A High device whose motion frames take under 9 ms and settled frames under 10 ms is promoted to Ultra once.
  - The decision is remembered per GPU in localStorage. A user's choice, or `?quality=`, is never overridden.
- **Moving is always cheap** (`RenderLoop.tsx`, `pipeline.ts`).
  - While the camera moves (drag, damping, auto-rotate, transitions), a one-pass motion pipeline draws: native pixel ratio, 2× MSAA. Its cost barely depends on the tier.
  - The tier's full pipeline (AO, TRAA, bloom, plus GI on Ultra) takes over 120 ms after the camera stops.
  - Planar reflections and similar extras hold their last picture during motion frames (`viewerMotion`).
- **Converging is short and never restarts for nothing** (`convergence.ts`).
  - High settles in 14 frames, Ultra in 20.
  - Textures, probe captures and environment maps arriving mid-settle extend the current run instead of restarting it.
- **Shadows are drawn once per change, never per frame** (`shadows.ts`). Content calls `invalidateShadows(scene)` when casters or lights change.
- **Light probes are cheap** (`CubeProbe.tsx`).
  - Captured only when their `captureKey` changes, at the tier's size, with no shadow redraw.
  - Their render targets are reused (`cube.ts`).
- **Content scales with the tier.** `useTier().spec` carries `density`, `shadowMapSize`, `probe`, `environmentSize` and `textures` (see `tiers.ts`), so the product's grass, foliage and texture sizes scale with the renderer.
- **First load.** `preloadViewer(load)` fetches the 3D chunk once the page has painted (in Fury, after the first still is shown), so entering 3D never waits on a download.
- **Reliability.**
  - `<Viewer>` rebuilds the renderer after a lost GPU device, up to 3 times. After that, or when no 3D backend exists, it shows `fallback` and calls `onUnavailable`.
  - The idle requestAnimationFrame loop of WebGPURenderer is stopped, so an idle page draws nothing.

## Using it

```tsx
// App shell (no three.js)
import { PerfHud, preloadViewer, useAdaptiveQuality } from '@fury/viewer360'
const loadScene = () => import('./MyScene')
const MyScene = lazy(loadScene)

const { quality, choose, identify, verdict, promote } = useAdaptiveQuality(onChange)
useEffect(() => preloadViewer(loadScene), [])
<MyScene quality={quality} promote={promote} onGpu={identify} onVerdict={verdict} />
<PerfHud />

// MyScene.tsx (lazy)
import { TIERS } from '@fury/viewer360'
import { OrbitRig, RenderLoop, Viewer, gpuKey } from '@fury/viewer360/3d'

<Viewer quality={quality} onRenderer={(r) => onGpu(gpuKey(r))} fallback={<NoWebGL />}>
  <MyProduct />
  <OrbitRig pose={{ position: [20, 10, 25], target: [0, 3, 0], fov: 34 }} interactive />
  <RenderLoop quality={quality} spec={TIERS[quality]} interactive promote={promote} onVerdict={onVerdict} />
</Viewer>
```

Product content rules:

- Call `invalidate()` (R3F) after a change. When a change touches shadow casters or lights, also call `invalidateShadows(scene)`.
- Report asynchronous arrivals with `sceneChanges.notify('textures' | 'probe' | 'environment' | 'content')`.
- Mark objects that probes should skip (dense foliage, helpers) with `userData.noProbe = true`.
- Read `useTier().spec` for anything whose cost should scale with the device.
- For offline stills, wrap content in `<TierProvider quality="ultra" spec={STILL_TIER}>` and drive the pipeline yourself (see `src/render-harness/`).

## Checking it on a device

Add `?debug=perf` to the URL. An overlay shows the tier, motion and rest frame times, triangles and draw calls, and the governor's decisions; `window.__viewer360.get()` returns the same data for scripts. `?quality=lite|high|ultra` pins a tier, and `?renderer=webgl` forces WebGL 2.
