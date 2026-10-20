# Platform overview — CTO view [DISCOVERED 2026-10-20, main-branch @ 0d813f1]

## Product

Concept configurator for Fury Co Gyms: Container Gyms and S-Series Studios, 20 or 40 ft.
The configurator is quote-only: `estimate()` returns `total: null`. Every gate is marked draft.

## Two experiences in one repo

| Route                  | Entry                             | Data model                        | Imagery                                                                                                              |
| ---------------------- | --------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/` (default)          | `legacyEntry.tsx` → `App.tsx`     | v3 `Config` (lz-string `#c=`)     | Live WebGPU scene + local path-traced stills, gallery of 9 angles, 360° mode                                         |
| `/?experience=library` | `prototype/ImageConfigurator.tsx` | v4 `DesignEnvelope` (`#fury-v4=`) | 400 pre-rendered Blender/Cycles WebP images (50 configs × 5 views + looks), opt-in live 360°, paid on-demand renders |

Recent work (PRs 25–34) is all on the library route. It is the strategic direction; v3 is legacy
but still the default URL.

## Stack

- **Frontend:** React 19, Vite 7, TypeScript 5.9 and Zod 4.
- **3D:** three r186 (`three/webgpu`, TSL) with R3F 9 and drei.
- **Path tracing:** three-gpu-pathtracer 0.0.27 (pinned and patched) with oidn-web denoise.
- **Serverless:** Vercel functions (`api/render-library/*`) over Supabase Postgres and Storage.
- **GPU rendering:** Blender 4.5 Cycles (OptiX).
  - It runs on a retained Vast RTX 5090, or in a Modal L40S sandbox.
  - A Modal CPU dispatcher on a 15 s schedule drives it.

## Strategic risks

- **Two parallel configurators.** v3 and v4 double the maintenance surface. The README configuration section still describes only v3.
- **Uncapped Vast rental.** The warm Vast 5090 is billed while idle, and the per-job ledger does not cap that cost.
- **Pinned pre-1.0 tracer.** The 360° refinement depends on an internal API of the pinned three-gpu-pathtracer 0.0.27 (`_pathTracer.update()`).
