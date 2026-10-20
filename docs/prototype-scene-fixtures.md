# Private scene preparation and fixtures

The CPU-only draft has been extended by [P03 private rendering preparation](p03-private-preparation.md). That guide is authoritative for the shared private scene recipe, pinned assets, source/build closure, 6 fixtures / 14 compositions / 28 cases, strict-reference jobs, CLI replay and remaining approval holds.

## Node API

Use Node 24 with the private loader. Never import the loader or these Node preparation modules from React, the public image protocol or mock service.

```ts
import { preparePrototypeScene } from './src/render/prototype/prepare.ts'

const prepared = preparePrototypeScene(untrustedDesign)
try {
  // Genuine owned CPU geometry with authored material specifications, not GPU materials.
  console.log(prepared.manifest.preparationDigest)
  console.log(prepared.manifest.rendererInput)
  console.log(prepared.manifest.assetValidation)
} finally {
  prepared.dispose()
}
```

- `preparePrototypeScene(input: unknown)` strictly parses a `DesignEnvelope`, prepares resources, records missing effects/rights/engineering holds and freezes the manifest. There are no arbitrary geometry, URL, transform, camera or sample-setting inputs.
- `PreparedPrototypeScene.parts` exposes owned local CPU resources; access after idempotent disposal throws. Never mutate resources and continue treating the old digest as authoritative. Builder caches live until process exit.
- `prototypePreparationAdapter` exposes only capabilities and preparation; no render or dispatch.
- `resolvePrivateThreeSceneInput` is the pure reconstruction resolver shared with the private Three worker. Its strict validation helper recomputes the entire recipe.
- `validatePreparationAssets()` checks the whole immutable texture inventory, not caller-selected paths, and returns verified integrity **with rights held**.
- `createPrototypeFixtures()` returns six strict draft definitions. `createG1ReviewBundle()` disposes every prepared resource and returns fixture scenes, 28 case-specific scenes, the G1 plan and blocked strict-reference jobs.
- `writePrototypeReviewManifests(absoluteNewDirectory)` writes 45 files with completion last. `validatePrototypeReviewDirectory(directory)` rebuilds and checks all bytes against current sources. Both require `NODE_ENV=production`.

See the P03 guide for exact CLI commands. No function above renders an image or clears rights. The original software captures retain their earlier identities and remain unqualified pipeline evidence.
