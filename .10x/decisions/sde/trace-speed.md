# Path tracing speed: start promptly, keep samples across camera moves

Status: implemented (stacked on PR #9's path tracer)
Owner: SDE
Requested: "path tracing until 1024 takes forever; achieve the maximum result within a few seconds,
and it shouldn't completely reload each time you change angles." The user also asked whether the
rendering could happen off-device instead.

## Findings

1. **The view never came to rest after an orbit.** `RenderEffects` treats any change of the camera
   matrix as motion. OrbitControls' damping shrinks the glide 5% per frame, so after a drag the
   camera kept moving by fractions of a pixel for ~640 frames (measured with the real
   `three-stdlib` controls: 10.7 s at 60 fps, 21 s at 30 fps). Only ~110 of those frames are a
   visible glide. Tracing could not start until the motion underflowed, then waited for the full
   raster settle (28-40 frames) and 220 ms more.
2. **Every camera move discarded all samples.** `begin()` reset the accumulation to zero and the
   view re-climbed to 1024 spp. The scene capture (BVH) was already reused; only the image wasn't.
3. Camera updates are uniform-only in three-gpu-pathtracer (no kernel recompiles), and the
   scene signature is stable across camera moves, so neither contributed.

## Decisions

1. **End the glide's invisible tail** (`src/render/motion.ts`, `CameraRig`). Below 0.6 px/frame
   the damping factor rises to 0.25; below 0.05 px/frame the glide is stopped by one undamped
   update (a final step under 0.2 px). Rest after a fast flick: 125 frames instead of 644.
   The visible glide is unchanged. Skipped while dragging, during camera transitions, in the
   interior look-around (controls disabled), and with auto-rotate.
2. **Start tracing after 6 still frames + 150 ms**, not after the full settle window + 220 ms.
3. **Seed each view from the previous one** (`src/render/history.ts`). The denoiser-guide raster
   pass becomes a 3-target G-buffer (albedo, view normal, world position + reuse weight) rendered
   at `begin()`. On `halt()` the accumulation, sample counts, positions, normals, and albedo are
   copied aside (36 B/pixel). The next `begin()` of the same scene signature runs a compute kernel that,
   per pixel, projects the surface point into the old view, bilinearly gathers old pixels whose
   position (within ~1.5 pixel footprints, widened for grazing angles and half-float precision)
   and normal (cos > 0.8) agree, and writes the mean color and an inherited sample count into
   the tracer's accumulation. Inherited count = old count x reuse weight x angular falloff x
   magnification falloff, capped at 75% of the target so every pixel keeps >= 25% fresh samples.
   - Reuse weight: per-object CPU factor (0 for tracer-excluded or unlit meshes, transmission, or
     stand-ins that trace as metal/glossy; x(1 - clearcoat)) times per-pixel
     `(1 - metalness) * smoothstep(0.2, 0.7, roughness)` from the raster material (maps
     included).
   - Light, not color, is reprojected: the gathered color is divided by the old view's albedo
     (+0.02 so near-black albedo cannot blow it up) and multiplied by the new view's rasterized
     albedo, so textures are never resampled. Where the gathered light has high local contrast
     (shadow and light edges), inheritance drops as 0.25 / contrast.
   - The tracer skips pixels at their sample limit, so new work goes to disocclusions, the screen
     edge, and glossy surfaces first.
   - A seeded view is first denoised at 2 spp.
   - Only the outputs use storage textures (WebGPU guarantees four per stage); inputs are
     sampled textures read with `textureLoad`.

## Rejected (for now)

- **Lower sample target or render scale:** changes the final image; the user asked for the same
  result faster.
- **World-space radiance cache / lightmap bake:** larger change to the tracer internals; the
  screen-space reuse covers the common case (orbiting around one design).
- **Off-device rendering:** a cloud GPU with hardware ray tracing (OptiX/Cycles or this tracer in
  headless Chrome) would give consistent few-second 1024-quality stills on any device, but needs
  a hosting account, a warm GPU (~$250-600/month always-on, or 10-60 s cold starts), and a
  scene-export path. Left for the user to decide; see the PR description.

## Verification

- Unit: `motion.test.ts` drives the real OrbitControls through a drag and release (644 -> 125
  frames to rest, final step 0.15 px); `history.test.ts` covers reuse weights.
- GPU: a local, git-excluded harness (`dev-history.html`, `dev/history-harness.ts`) runs the real
  session on SwiftShader WebGPU at 96x64: a matte floor, wall, and box, a polished metal sphere,
  and a glass pane, sun and sky. View A is traced to 32 spp, the camera orbits 6 degrees, view B
  is seeded and traced on to 32 spp, then B is traced from scratch to 32 spp and to a 256-spp
  PCG reference.
  - 85% of pixels inherit samples (92% of matte ones); none of the 430 metal/glass pixels do.
  - Time to 32 spp: 14.8 s seeded vs 27.3 s fresh (1.84x; GPU-bound ratio, CPU-emulated).
  - Mean per-pixel error vs the reference: 4.15% seeded vs 4.78% fresh (8x8 blocks: 1.03% vs
    1.07%; no brightness bias). The seed alone, before any new sample, is already closer to the
    reference on the pixels it covers (3.51%) than the fresh 32-spp image (4.30%).
- Not measured: wall-clock on real GPUs, OIDN time per milestone, large orbits and zooms.
