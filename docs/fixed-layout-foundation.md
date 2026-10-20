# Fixed-layout foundation — local P01 slice

This is a bounded implementation foundation, **not P01/G0 completion or a customer-app migration**. The four equipment inventories remain `arrangement-draft-1`, with open manufacturer, clearance and Container ceiling/overhead-door issues. The app still uses its v3 configuration and editable equipment UI. No rendering service, paid job, deployment or production approval is introduced.

## What is implemented

- `src/domain/arrangements.ts`: one immutable proposed mapping for Studio/Container × 20/40 ft. The 18 item instances and transforms match the G0 review pack. Dimensions come from the existing `CATALOG`, not a second handwritten equipment specification. Occupied rack width includes its loaded bar. This module snapshots the dimensions it uses; changing source dimensions changes resolved identity.
- `src/domain/fixedLayout.ts`: a strict, versioned **layout sub-contract**. Unknown keys, arbitrary equipment, package overrides, mismatched references, unknown catalog versions and invalid sizes are rejected. Family/size commands replace the arrangement in one returned state; a consumer can use that state as one Undo step. This is not yet wired into the existing history reducer.
- `src/domain/legacy.ts`: JSON-only, read-only equipment equivalence inspection. It compares SKU/position/rotation multisets, not package labels, item IDs or item order. It retains the exact original string, never writes storage and never auto-migrates. Matching equipment is explicitly **not** full semantic equivalence: structure, appearance, arbitrary time and retired presentation choices remain unassessed. Opaque compressed shares are not decoded by this inspector.
- `src/lib/recovery.ts`: exact raw archival with recovery-key collision protection and read-back verification. `archiveLegacyOriginals()` snapshots the old draft/library namespaces without parsing or overwriting them. If archival fails midway, originals and any already-created archives remain; callers must not proceed with migration.
- `writeSaved()` now archives malformed/non-array libraries, unreadable entries and originals with more than 12 readable entries before replacement. Future/unreadable entries are still carried into the current library. `writeDraft()` verifies recovery copies, including an empty original. Recovery failure blocks replacement; a detected intervening write also blocks replacement.

## Contract example

```json
{
  "contract": "fury.fixed-layout",
  "contractVersion": 1,
  "catalogVersion": "fury-arrangements-draft-1",
  "product": { "family": "studio", "lengthFt": 20 },
  "arrangementRef": "studio-20-review@1"
}
```

This deliberately does **not** claim to be the proposed product/presentation v4 envelope. Retained options, looks/views and other pending product decisions must not be invented to complete a schema. There is no new customer import UI or persisted v4 namespace in this slice.

```ts
const layout = createFixedLayout({ family: 'studio', lengthFt: 20 })
const changed = transitionFixedLayout(layout, { lengthFt: 40 })
const preview = resolveFixedLayoutForReview(changed.next)
const gate = fixedLayoutProductionGate(changed.next) // allowed: false
```

All four records are drafts. The production gate always denies this catalog; there is no caller-supplied approval override. The review resolver is named and labeled as such. This is a library contract, **not server authorization or a retrofit of the legacy GPU routes**. Future admission/render/export code must enforce its own approved-release, identity, access and budget checks. Nothing here authorizes a GPU request.

## Identity boundaries

Serialization uses schema-defined property order. SHA-256 binds the parsed layout contract, catalog version, unit convention, resolved item transforms and their catalog dimensions/illustrative clearances. Input object key order does not change the identity. All four mappings have different hashes.

This is a **layout digest only**, not a full design or image cache key. It does not bind the shell, option compatibility, materials, environment, lighting, door pose, camera, renderer build, finishing or output profile. Those belong in the later canonical resolved visual identity. No old baked image is relabeled, and no historical image equivalence is claimed.

## Recovery guarantees and limits

- Archives contain the original storage string, without parse/stringify normalization, even when it is malformed or from a future schema.
- A recovery archive is read back before the original can be replaced. Quota/security errors, discarded writes or collisions fail closed.
- Known unreadable library entries are also retained in the visible library payload for compatibility. Recovery archives are not automatically pruned; retention/recovery UX is still a separate decision. Repeated saves of libraries with unreadable entries can consume storage and eventually block writes rather than discard data.
- The source value is rechecked before replacement. This detects some intervening writes; `localStorage` has no atomic compare-and-swap, so it does **not** guarantee multi-tab transactions.
- The current app still edits v3 designs. The archive helper alone does not implement read-only legacy UI, consented copy conversion, rollback readers or safe v4 autosave. The future conversion must write a separate namespace after preserving originals and obtaining consent; never overwrite a legacy original.

## Verification

With Node 24 and the repository dependencies:

```sh
npm test -- src/domain src/lib/recovery.test.ts src/lib/config.test.ts
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Tests cover all 16 family/size transitions, serialization and identity, fixed-reference/unknown-field rejection, immutable resolved records, production denial, v1–v3/raw-future preservation, transform-based comparison, quota/read failures, silently discarded recovery writes, collision handling and intervening writes. The local test run is not browser E2E, engineering approval, render qualification or laptop performance evidence.

## Integration and rollback

The only existing application behavior changed is safer storage writing. New domain modules have no production UI consumers. Apply the narrow patch to the preserved G0 candidate, not directly to an unrelated main-branch state. Do not deploy merely because checks pass.

Rollback removes the new domain integration and restores prior source files; **do not delete recovery keys or originals**. Rolling back the storage fix also restores the prior data-loss risk. No storage schema migration has run, so no reverse migration is required.

Next work: approve the exact equipment/compatibility envelope and retained options; finalize the complete product/presentation contract; then wire fixed commands, read-only plans, library/history/share boundaries and explicit legacy copy conversion. Rights, real devices, renderer selection and a fresh spending ceiling remain separate gates.
