# Live 360° speed and quality: design

See ADR-001 and `specs/2026-10-20-live-360-speed-quality-design.md`.

## Components

- **`src/viewer/liveProfile.ts`** (new, pure): `liveProfile(quality)` returns `{ samples, maxBounces,
renderScale, fadeMs }`.
- **`PathTraceSession`** gains options:
  - `renderScale` and `fadeMs`;
  - `MILESTONES` extended to 1024;
  - `begin()` walks the scene once.
- **`ProgressiveRenderer`** changes:
  - a frames-drawn start gate;
  - a textures-only tracer invalidation;
  - `keepDecodedTextures` for the tracer's lifetime;
  - a shader warm-up before the first frame.
- **`ImageConfigurator` / `StageToolbarView`** add an intent prefetch (hover, focus, touch) of the 360°
  chunk, the tracer module and the design's textures.

## Failure modes

- If the warm-up times out (1.5 s), render anyway.
- If prefetch fails, it is silent; the normal click path still loads everything.
