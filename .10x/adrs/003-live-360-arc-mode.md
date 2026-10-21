# ADR-003: Optional limited-arc exterior orbit (`?arc=N`)

**Status:** Accepted (experimental flag)
**Date:** 2026-10-20
**Feature:** live-360-speed-quality

## Context

The user asked whether limiting the exterior orbit to about 180° and slowing the spin would give a
smoother, sharper view for the same compute.

The investigation found that the 4 exterior customer cameras span up to about 208° on courtyard
designs, because rear-left mirrors (`gallery.ts:1235`/`:1266`). A fixed 180° window would make
customer views unreachable.

## Decision

- `?arc=N` (30 ≤ N < 360) gives a _minimum_ window.
  - The final span is max(N, the smallest circular arc that covers the 4 exterior customer
    cameras and the home pose, plus 2×10°).
  - The window is computed per design in `src/viewer/arc.ts`, which is outside `src/render` so
    `RENDER_VERSION` doesn't change.
  - A span of 350° or more means unlimited.
- `CameraRig` applies the limits imperatively:
  - unlimited while an ease runs;
  - applied, widened to include the current azimuth, once the ease lands;
  - never moved under a still camera.
- Lower `rotateSpeed` under the arc.
- The leftover glide is cleared at a limit.
- Arrow-key steps are clamped to the room left.
- Auto-rotate becomes a time-based ping-pong sweep under the arc.
- The interior view is unchanged.
- The flag is off by default; it is benched against the free orbit before any default change.
- Scenery culling for the arc is deferred. Toggling `visible` would change the tracer's structure
  and drop GI and raster shadow casters; doing it properly needs camera layers.

## Alternatives Considered

| Alternative                              | Why Not                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| A fixed 180° window centred on the front | Makes rear-left unreachable on courtyard designs                                         |
| OrbitControls' max angular velocity      | `sphericalDelta` is private in three-stdlib; rotateSpeed and damping are the only levers |

## Consequences

- Pros: a denser history reuse arc and slower motion when the flag is on.
- Cons: more CameraRig state.
- Risk: three-stdlib's non-wrapping clamp can jump edges near ±π. Mitigated by computing the window
  around home with a continuous centre and by widening before applying.
