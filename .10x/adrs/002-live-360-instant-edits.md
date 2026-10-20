# ADR-002: Instant finish/floor edits — persistent geometry and surface-tolerant history

**Status:** Accepted
**Date:** 2026-10-20
**Feature:** live-360-speed-quality
**Author:** 10x-Team (Architect + Staff Engineer)

## Context

A finish or floor edit in the live 360° view rebuilds every unit part list. `shellKey` contains the
finish, and every list key includes `shellKey`. Two things follow:

- `batch()` merges new geometries, and `Parts` keys meshes by `material.uuid`.
- The path tracer sees a new `structure`, because identity fingerprints read `object.id` and
  `geometry.id`. It therefore rebuilds every BVH on the main thread (`setScene`).

Sample history is also lost on every edit. It is lost three ways: `begin()` clears it on any
signature change; `invalidate()` sets the signature to -1, so `halt()` stores under -1; and
`MultiViewHistory.store` clears whenever the signature changes. Texture arrivals take the same
path, and they also force a full `setScene` (`captured = null`).

The Phase 2 investigation (workflow `phase2-understand`) probed 23,552 part lists. All 7 finishes
and all 4 floors keep the same batch partition, keyed by content (`batchKey`).

## Decision

1. **Persistent merged geometry, live viewer only.**
   - `parts.ts` gains `cachedBatches(parts)` (render), and `acquireBatches(batches)` and
     `releaseBatches(batches)` (effects), a reference-counted cache
     keyed by `batchKey`. `batch()` stays pure: tests and Equipment's per-SKU cache rely on that.
   - Entries with no references are evicted on a macrotask, never a microtask, because React
     passive effects can run after the next task.
   - `Parts` keys meshes by `${batchKey}:${shadow}`, with a guard against duplicate keys.
   - The behaviour is enabled by a `GeometryReuse` context that only the library's
     `LiveDesignScene` turns on. The legacy route stays unchanged.
2. **`texturesChanged()` instead of `invalidate()` for texture arrivals in the live viewer.** It
   keeps the capture and forces `updateMaterials` on the next `begin()` when the structure is
   unchanged. It also bumps a scans epoch.
3. **Surface-tolerant history, opt-in (`keepHistoryAcrossSurfaces`, live viewer only).**
   - History is keyed by a _content_ scene signature: geometry keys, transforms, lights, look, and
     emissive/transmission transport.
   - Each stored view also keeps its full surface signature.
   - A view seeded across a surface change is capped at an absolute `RESTYLED_SAMPLES = 16`.
   - `halt()` stores under the keys computed at `begin()`.
   - The legacy stills and exports keep their current behaviour: any change clears history.
4. **Skip hardscape scans the Studio look never shows.** `Landscape` skips building the hardscape
   it doesn't show on the Studio look. Those 7.8 MB of scans held the trace gate.

## Alternatives Considered

| Alternative                                                                   | Pros                    | Cons                                                                                                         | Why Not                                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Material slots (take finish out of list keys, resolve slot→material at mount) | No list rebuild CPU     | Large refactor of builders and of how materials are chosen                                                   | The content-keyed cache gets the same identity with far less code. The rebuild CPU (about 35 ms in Node) is measured on the bench |
| Make `batch()` itself cache                                                   | One API                 | Breaks its purity, `parts.test.ts`, and Equipment's lifecycle                                                | Riskier                                                                                                                           |
| History share 0.5 after an edit                                               | Simple                  | Leaves 18–50% of the bounce-light error in a settled image, because the adaptive sampler retires tiles early | An absolute cap of at most `MIN_SETTLE_SAMPLES` bounds it                                                                         |
| Precompile sibling materials                                                  | Avoids compile on click | Finishes already share one NodeBuilderState and pipeline; siblings would download about 48 MiB of scans      | No gain, real cost                                                                                                                |

## Consequences

### Positive

- A finish or floor click becomes an in-place material update: no BVH rebuild, no mesh remount.
  The next trace is seeded.
- Texture arrivals no longer rebuild the BVH or wipe the orbit history.
- The default Studio look stops downloading hardscape it never shows.

### Negative

- The cache keeps index, tangents and BVH on zero-reference geometry until eviction.
- The first image after an edit carries up to 16 samples of re-lit history, which converges away.

### Risks

- `updateMaterials` with a growing material count reallocates buffers and the atlas. This is the
  library's intended path, but it has not been GPU-tested here.
- Partition invariance is an observed property, not a guaranteed one. A test guards it, and a
  cache miss falls back safely to `setScene`.

## Dependencies

- ADR-001.
- three-gpu-pathtracer 0.0.27 `updateMaterials`/`updateLights` semantics.
- three r186 `Bindings` rebinds replaced storage attributes.
