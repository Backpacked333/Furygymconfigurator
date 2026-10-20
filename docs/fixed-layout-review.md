# Fixed-arrangement review workspace — local P02 slice

## Scope

An isolated, development-only workspace exercises the fixed-layout foundation without changing the existing customer app. It renders read-only SVG footprints and inventory, **not product photography or a qualified renderer output**. It contains no GPU controls, production-image exports, purchase flow or new equipment editing paths.

All four layouts remain proposals. Manufacturer dimensions, use/access clearances, Container ceiling/overhead-door compatibility and other product decisions are still open. This is not a G0/P01/P02 sign-off or an engineering approval. The review page is intentionally separate from the legacy configurator: it must not imply that the current editable UI has been replaced in production.

## Run locally

Use Node 24 and the existing repository setup:

```sh
npm ci --no-audit --no-fund
npm run dev -- --host 0.0.0.0 --port 5173
```

Open `/review.html` on that local Vite server. The usual `/` entry remains unchanged. The review entry uses `import.meta.env.DEV` and is not an input to the normal production build. Do not deploy the dev server or add this page to production inputs to bypass the approval gate.

The review entry imports React, local fonts, domain/configuration helpers and SVG UI. It does not import `App`, the 3D scene or the renderer/session modules. No application server setup, credentials or rendering provider is required. Even when cloud renderer environment variables exist for the old application, this review entry does not call its rendering paths.

## Supported review flow

1. Choose Studio or Container, and 20 or 40 ft. Each command changes the family/size and its single matching arrangement together.
2. Inspect numbered, read-only equipment footprints and the matching inventory. There are no move, rotate, add or remove handlers. Feet/metres and the illustrative halo overlay affect display only, not design identity.
3. Undo/Redo complete layout states, up to 50 past changes. A new selection after Undo clears Redo history.
4. **Save review** explicitly saves the current layout in `fury-fixed-review-v1`. There is no autosave and no write during initial rendering or share restoration. The saved-state indicator compares the current layout with the last loaded/saved snapshot.
5. **Copy local review link** copies a strict `#layout=...` fragment. The link needs this workspace running at the same address; it is not a published customer share. Unrelated query parameters and URL credentials are excluded. Clipboard failure points to JSON export instead.
6. **Export review JSON** downloads the layout sub-contract only. It is not a complete v4 product/presentation configuration, safety certificate or a strict image export. No general JSON/file import UI has been added.

## Unsupported data is not silently converted

- An unsupported/malformed share remains available as its exact original fragment. The visible plan is explicitly labeled as the current review, not that share's design. Valid hash changes can be undone and never autosave.
- An unreadable/future saved review remains untouched and disables ordinary Save. The page explicitly states that the displayed plan is a separate review. Its original text can be downloaded immediately.
- **Preserve original and save review** is an explicit replacement action for this review-only slot. It archives the exact original, verifies the archive by reading it back, checks for an intervening write, then saves the chosen review. Recovery/quota failures block replacement.
- Recovery copies remain browsable/downloadable through **Original designs & recovery → Inspect saved originals**, including after reloading. The panel only enumerates known Fury recovery-key prefixes, pages the list five at a time and does not display payload content inline.
- Existing `fury-draft-v1` and `fury-builds-v1` values are read only on inspection. Their raw bytes can be downloaded or copied to verified recovery keys. They are never converted, edited, deleted or replaced here, including opaque compressed drafts and malformed libraries.
- Downloads reflect the last inspected snapshot. Preservation re-reads current values. There is no automatic archive eviction; browser storage quotas can block further writes rather than discard originals.

`localStorage` has no atomic compare-and-swap: source rechecks detect some conflicting writes, not every multi-tab race. A changed snapshot blocks save and asks the user to export before reloading. Storage denial keeps the review usable in memory with JSON export; there is no false saved-state confirmation.

## Verification and evidence boundaries

```sh
npm test -- src/review
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Unit and jsdom component tests exercise strict share/save validation, all layout mappings, atomic history, read-only equipment events, recovery consent, exact raw downloads, quota failures, denied storage, archive discovery and clipboard fallback. These tests do not prove CSS layout, browser download behavior, native focus handling, printed output or physical-laptop performance. Clipboard and download calls are mocked in component tests.

The local handoff additionally checks the review entry's compiled dependency graph for renderer/Three.js imports and verifies that the normal production output excludes this review workspace. These are build/dependency checks, not real-device latency measurements.

### Recorded local browser pass — 2026-10-18

The separately approved browser pass exercised this workspace at 1280×800, 1366×768 and 1440×900, using isolated synthetic storage, actual clipboard links and actual file downloads. It found an internal skip-link/hash collision: the skip anchor was being interpreted as an unsupported share. The fix focuses the main element without changing the fragment; three unit regression cases and native keyboard retests cover empty, valid-share and unsupported-fragment states.

The corrected run recorded 94 passing runtime assertions, including restoration/share history, exact export/recovery downloads, unsupported fragments, recovery pagination and effective storage-failure/intervening-write injections. Unchanged arrangement counts, read-only gestures, units/halos and rack dimensions retain the first run's evidence; they were not exhaustively repeated after the focus-only fix. The revised handoff includes the runtime summary and evidence index. No render/API/external submission or canvas was observed.

Remaining limits: no physical-device timing, screen-reader speech, printed-output validation, real disk exhaustion or atomic multi-tab guarantees. Supporting text is small; the page requires substantial vertical scrolling at shorter laptop heights, and preservation-error feedback near the footer may require scrolling despite its `role=alert`. Passing this local browser procedure does not approve the arrangements or qualify the customer image-first experience.

## Integration and rollback

This slice only adds the isolated review entry/components and documentation. It does not modify the customer entry, existing editable plan, legacy share parsing, actual catalog arrangements or rendering infrastructure. Apply its incremental patch after the preserved P01 foundation, or use the combined P01/P02 patch against the exact G0 candidate.

Rollback removes the review entry and modules; keep `fury-fixed-review-v1` and all recovery keys untouched. No reverse migration is needed. The prior v3 app remains unchanged and does not consume the new namespace.

Before customer cutover: approve the inventories/compatibility envelope and retained options; complete the v4 structure/appearance/presentation contract; implement consented copy conversion into a separate approved design; wire all customer entry/history/share paths to that authority; and verify the image-first render flow independently. This development workspace intentionally does not pretend those gates are complete.
