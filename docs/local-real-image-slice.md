# Local real-image slice — frozen lane interface

This is an unpublished pipeline proof, not G1/art/rights/engineering approval. The familiar B UI, default v3, mock v1, catalog, storage and history behavior remain unchanged. Never relabel historical `97f204ffff` stills. No cloud, paid work, downloads or deployment. Strict/Cycles exports and 360 stay gated. Protocol/schema tests are not captured-image evidence.

## Approved single retry extension

After the three retained failures below, Roy selected **“Allow one additional local retry.”** The diagnostic ceiling is now three rather than two, solely to admit one further Obsidian retry against the same retained ledger. The eight-attempt total, six successes, concurrency one, 180-second job cap, 1,530-second aggregate cap, software/Lite profile and network restrictions are unchanged. This supersedes the original two-retry ceiling below; it does not authorize unlimited retries, paid GPU work or deployment. Stop on another failure. The approval and pre-retry history hashes are retained in `approved-retry-004.json` outside source.

## Selection and ownership

Use the existing DEV image application route `/?prototype=images&imageMode=local-real`, not a new product/page/theme. `isLocalRenderSelection(import.meta.env.DEV, location.search)` selects this mode; ordinary `?prototype=images` stays mock. The host must require **both** `FURY_IMAGE_PROTOTYPE=1` and `FURY_LOCAL_REAL_IMAGES=1`, Vite `serve`, nonproduction mode/NODE_ENV and not preview. Flags are operator configuration, never browser authority. If the real service is absent, show unavailable, never silently fall back to mock or historical imagery.

Build lanes:

1. **Contract lane (this change):** `src/image-service/localRenderProtocol.ts`, its tests; pure `src/domain/localRenderSlice.ts` (experiment selection only, not a catalog change); `src/render/prototype/capture/contract.ts` and directly affected contract/validation-fixture tests; this frozen interface document.
2. **Node/service/capture lane:** new Node-only local real service/cache/HTTP modules and tests under `src/image-service/`; private runner, host, artifacts, runner-browser, browser capture modules and directly affected tests under `src/render/prototype/capture/`; `scripts/prototype-capture.ts`, service plugin and Vite DEV integration. Do not import Node modules from the client. Capture host must permit the pure domain helper, not image-service/private runner imports in its browser graph.
3. **Client/UI lane:** new browser real image client/hook and tests; minimal integration into existing `src/prototype/` and stage presentation. No renderer in controls, save/share/history. No global stylesheet/theme or default v3 changes. Parent assigns any disputed file before editing.

Only authorized integration/parent work may run actual captures. No build-lane renderer attempts or customer app/browser testing. Final UI testing is a separately authorized testing-agent activity.

## Exact two supported values

`LOCAL_RENDER_SAMPLES`, `localRenderDesign('obsidian' | 'bronze')`, and `matchLocalRenderSample(input)` come from the pure helper and are re-exported by the public protocol. Invalid design throws; valid other design returns null. `createLocalRenderRequest` / `parseLocalRenderRequest` reject null matches with `UnsupportedLocalRenderDesignError.code === 'unsupported-design'`.

The default is catalog **Obsidian**, the requested default charcoal appearance; no invented `charcoal` finish ID. Both values derive from strict `defaultDesign({family:'studio',lengthFt:20})`; only Bronze changes `appearance.finish`. Both have this full envelope (replace `obsidian` with `bronze` for the other):

```json
{
  "config": {
    "schemaVersion": 4,
    "catalogVersion": "fury-design-draft-1",
    "product": { "family": "studio", "lengthFt": 20 },
    "structure": {
      "kind": "studio",
      "layout": "single",
      "door": "hinged",
      "addons": [],
      "railing": "glass"
    },
    "appearance": {
      "finish": "obsidian",
      "accent": false,
      "interior": "gallery",
      "floor": "rubber",
      "mirror": false
    },
    "arrangementRef": "studio-20-review@1"
  },
  "presentation": {
    "lookRef": "courtyard-day-draft@1",
    "doorPose": "closed",
    "cameraRef": "front-left-draft@1",
    "aspect": "wide"
  },
  "outputProfile": "web-hero"
}
```

The canonical exported values are authoritative, not copied JSON. All other controls stay editable but produce **no matching rendered preview**. Do not crop/reuse wide as tall or reuse wrong finish, additions, door pose, camera, look, family, size, interior, arrangement or output profile.

The existing `studio-20-front-left-wide` sample already is the exact Obsidian design, so **reuse its ID**, not a new alias that could evade the successful-sample rerender ban. Add only `studio-20-bronze-front-left-wide`. The prior six samples retain order, meaning and roles; there are now seven selectable sample IDs, still at most **six successes, eight attempts, two diagnostic retries, one process, 180 seconds/job, 1,530 seconds total**. Selection count is not a budget increase. No successful sample may be rerendered, including after a build change: stale cache then reports unavailable pending explicit operator direction, not a new namespace/budget.

## Public wire contract

Import only `src/image-service/localRenderProtocol.ts` in the real client. It has no Node/Three/private-capture/mock-v1 imports. Separate protocol `fury.local-render-images`, `protocolVersion: 1`, `mode: 'local-real'`; the old `/__fury-prototype/v1` and `fury.prototype-images` remain mock-only.

| Operation                                                      | Request / result                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /__fury-prototype/local-render/v1/images`                | `createLocalRenderRequest(design)`; 200 ready exact cache or 202 queued/rendering              |
| `GET /__fury-prototype/local-render/v1/image-jobs/:interestId` | 200 `LocalRenderReply`; use `localRenderStatusPath`                                            |
| `POST .../image-jobs/:interestId/cancel`                       | `createLocalRenderCancelRequest`; only detaches interest, never claims GPU/job cancellation    |
| `GET .../image-jobs/:interestId/image/:sha256Hex.png`          | Only exact ready bytes for this interest and checksum, `image/png`; use `localRenderImagePath` |

No caller file path, sample override, asset URL, provider, backend, command, query URL, arbitrary camera or output settings. Exact loopback peer/Host, exact same local Origin on POST, same-origin GET/fetch metadata, no forwarding headers, no CORS; reject duplicate sensitive headers, query/encoding/path ambiguity, body on GET, unknown methods/routes. Adapt existing mock HTTP safety, not its renderer or budget. Bound actual uncompressed UTF-8 bytes before parse (16 KiB request, 64 KiB response metadata), reject compression/non-JSON and use finite deadlines/concurrency. Never trust Content-Length alone. Return private/no-store plus nosniff and same-origin resource policy. Opaque 24–128-character interest IDs are local capabilities, not production authentication; no new budget principals.

Request example:

```ts
const design = localRenderDesign('bronze')
const request = createLocalRenderRequest(design)
// { protocol:'fury.local-render-images', protocolVersion:1, mode:'local-real', design }
```

Reply construction example (hashes/build must come from actual validated job, not examples):

```ts
const base = localRenderReplyBase(interestId, job.identity, {
  captureDigest: job.identity.captureDigest,
  build: job.build,
  profile: job.profile, // exact LOCAL_RENDER_PROFILE / local-review-wide@1
})
const queued = { ...base, state: 'queued', retryAfterMs: 500 }
const ready = {
  ...base,
  state: 'ready',
  artifact: {
    checksum: validated.artifact.digest,
    mediaType: 'image/png',
    src: localRenderImagePath(interestId, validated.artifact.digest),
    width: 640,
    height: 400,
    byteLength: validated.artifact.bytes,
    exactMatch: true,
    approvedCurrentImage: false,
    cacheStatus: 'verified-exact-hit', // or captured-miss for newly completed work
    provenance: {
      kind: 'local-three-capture',
      label: LOCAL_RENDER_LABEL,
      captureProtocol: 'fury.local-three-capture@1',
      jobId: job.jobId,
      sampleId: job.sampleId,
      receiptDigest: marker.receipt.digest,
      runtime: validated.runtime,
      holds: validated.holds,
      flags: LOCAL_RENDER_FLAGS,
    },
  },
}
```

`requested` is domain `{designDigest,presentationDigest,requestDigest}`. `capture` is `{captureDigest,build,profile}`; build contains sourceManifestDigest, assetManifestDigest, bundleDigest, lockfileDigest, threeRevision. PNG `checksum` is a third independent identity over actual encoded bytes. Never substitute any of these hashes for another. `captureDigest` recomputation is the Node private contract's responsibility, including actual derived camera and full profile, not echoed request hashes. Browser parsing validates logical identity; subsequent polling validates the frozen initial capture/build/profile. It does not authenticate the local server or independently verify source files.

`LocalRenderReply` states: queued/rendering (bounded retryAfterMs), ready (artifact only here), failed (typed error), expired, cancelled (`cancellationScope:'interest-only',sharedWorkCancelled:false`). `localRenderErrorReplySchema` is `{protocol,protocolVersion,mode,error:{code,message,retryable:false}}`. Unsupported-design is 422, invalid JSON 400, byte cap 413, media 415, methods 405, nonlocal/origin 403, not found 404, capacity 429, unavailable/capture-failed 503, timeout 504, identity/artifact failures fail closed 503. No automatic render retry. Diagnostic retry is operator-only and consumes the SAME retained attempt history.

Exported parsers: `parseLocalRenderRequest(Text)`, `createLocalRenderRequest`, `parseLocalRenderReply`, `parseLocalRenderSubmissionReply`, `parseLocalRenderStatusReply`, `parseLocalRenderCancelReply`; helpers `localRenderReplyBase`, status/cancel/image paths, `createLocalRenderCancelRequest`, `isLocalRenderSelection`, `isCurrentLocalRenderDesign`, `validateLocalRenderImage`. Exported types: `LocalRenderRequest`, `LocalRenderBuild`, `LocalRenderCaptureBinding`, `LocalRenderReply`, `LocalRenderReadyReply`, `LocalRenderPendingReply`, `LocalRenderSubmissionReply`, `LocalRenderArtifact`, `LocalRenderError`, `LocalRenderErrorReply`, `LocalRenderImageDecoder`, `LocalRenderSampleId`. Exported strict schemas are named `localRender*Schema`.

## Client and provenance obligations

Capture the submitted full envelope and a monotonically increasing selection generation. Invalidate/hide the current image immediately when any full design changes, abort/detach obsolete interest, and compare generation **after** every await, reply parse, image fetch and decode. Design equality alone cannot prevent A→B→A races. Poll the frozen initial capture binding and interest, bounded by the original deadline; do not endlessly resubmit on failure. Duplicate requests coalesce server-side by capture digest. Save/share/history never wait for rendering.

Fetch only the recomputed same-origin `artifact.src` with redirect error and stream cap 2 MiB; check HTTP/media type and actual URL. `validateLocalRenderImage(artifact,bytes,decoder)` hashes a snapshot of actual bytes, checks PNG signature/header/dimensions, then independently decodes those bytes (browser `createImageBitmap` or `Image.decode`). Display only the verified bytes through a client-owned Blob URL, not a second unverified remote fetch; revoke obsolete URLs. The Node decoder additionally validates CRC, inflate bounds and opaque nonuniform pixels. Neither echoed JSON nor synthetic test decoders establish real-image evidence.

Always label **Local render — unqualified software preview**, display `local-review-wide@1`, **640×400 / Lite / AgX / 4x MSAA**, and actual `runtime.backend`, `acceleration`, adapter/browser observations. Runtime is restricted to this measured software/WebGL2 lane, not arbitrary hardware claims. Keep all review holds. `exactMatch:true` means exact supported request/build/profile binding, not calibrated appearance/approved final imagery. `approvedCurrentImage`, productionAllowed, paidExecutionAllowed, strictReference, g1Qualified and visualParityClaimed remain false. Preserve all runtime effect details: Lite lacks AO, screen-space GI/reflections, bloom and path tracing; mirror is probe-lit approximation rather than planar reflection; thin glass/transmission and site light field limitations must be explicit. No photorealistic/production-speed claim.

## Node invocation, import and persistent cache

Node 24 executable: `/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node`. Integrate-stage only:

```text
node scripts/prototype-capture.ts --sample studio-20-front-left-wide --out /home/ubuntu/Documents/fury-real-handoff/capture-obsidian-001
node scripts/prototype-capture.ts --sample studio-20-bronze-front-left-wide --out /home/ubuntu/Documents/fury-real-handoff/capture-bronze-001
```

Paths are examples: choose a genuinely new absolute output directory under a verified real existing parent. The CLI uses fixed argv and an owned headless profile; never customer app UI, external browser profile, shell interpolation or user command strings. Successful outputs are immutable `image.png`, `receipt.json`, `job.json`, `build.json`, manifest chunks, browser/progress observations and **COMPLETE.json**, committed last. `COMPLETE.pending.json` is not success. Failed outputs retain failure evidence. Exit/stdout is not sufficient verification.

Node-only existing imports: `prepareCaptureBuild(fence)` / `PreparedCapture.build`, `.manifests`, `.revalidate()` from host; `captureIdentity`, `createCaptureJob`, `validateCaptureJob`, `validateCaptureReceipt`, `captureCompleteSchema`, `validateDecodedArtifact` from contract; `decodeCapturePng` / `digest` from artifacts; optional `runCapture({sampleId,outputDirectory,kind:'sample'},signal)` with the loader/root precautions below. If spawning CLI, consume only bounded metadata files after exit and revalidate independently; never import private capture into the customer's image route.

Stable service cache/index directory: **`/home/ubuntu/Documents/fury-real-handoff/local-real-image-cache`**. Immutable capture output directories are siblings, not entries rewritten in place. This index is NOT a spend ledger and grants no new rendering budget. Canonical retained capture history remains exactly **`/home/ubuntu/Documents/fury-capture-handoff/local-three-capture-history`**; no substitute HOME namespace, worktree-relative history, new principal or reset. Server must serialize/coalesce local misses and leave uncertain running history blocked.

Before every cache hit, recompute/validate current source/asset/bundle/lockfile/profile identity, compare captureDigest, validate the completed marker/receipt against the expected supported job, hash receipt bytes, read/hash/decode image bytes independently, confirm dimensions and full review/runtime metadata. Resolve only trusted output paths recorded by the service/history, reject symlinks/outside roots/replacements and arbitrary requests. Rebuild index from already successful immutable artifacts after restart; do not render merely because the index is missing. Source/build change invalidates reuse; a prior successful sample still cannot rerender under the retained budget. Read-only current-build preparation is not a capture attempt; ensure deterministic digest and input revalidation before publishing/cache hit. Fail closed if current identity cannot be established.

## Development-server build identity

Vite's development server sets `NODE_ENV=development`. An in-process private build then resolves development React modules and produces different source/bundle digests from the original CLI capture, even when every captured source file is unchanged. The first real-image UI readiness check correctly failed closed with `identity-mismatch` before displaying an image.

Metadata preparation now runs in one private Node worker with its own fixed `NODE_ENV=production`, matching the original capture build environment without modifying the UI server's environment or DEV gate. The worker retains the prepared resources, revalidates their original bytes, rejects replaced generations, refreshes operation deadlines and terminates on cancellation, timeout or service close. No renderer, capture admission or HTTP listener runs in this metadata worker. The original capture host, source closure, PNGs, receipts, ledger and identity validators are unchanged.

Regression probes under both parent environments reproduce the same build and leave the parent environment unchanged. The development-environment cache-only HTTP probe matched all original build digests and both PNG hashes, invoked zero capture callbacks and preserved every history hash. Observations were 6.30 seconds cold-service, 0.98 seconds warm Bronze and 0.88 seconds warm Obsidian; these remain local observations, not browser or p95 qualification. The approved UI pass uses a separate capture-rejecting test wrapper: no new rendering is authorized by this fix.

## Actual integration status: two real PNGs

The approved additional Obsidian retry (`diagnostic-capture-004`) succeeded, followed by the originally scoped Bronze sample (`local-render-capture-5f28dfc7-bdbb-4f2f-a5c5-e1175010659d`). Both are actual 640×400 PNGs from software WebGL2/Lite, eight rendered frames, same source/asset/bundle identity and authored camera. Only `config.appearance.finish` differs. The retained attempts took **51.54 and 53.96 seconds** including startup/publication, not production-grade latency. Each browser observed 53 local requests, zero host denials, zero console errors and confirmed owned-process cleanup.

- Obsidian: 534,730 bytes; SHA-256 `487922b85cb08a59e71d29a1fdcca963e6418d86ba0191ca234373b600491d5d`.
- Bronze: 533,645 bytes; SHA-256 `9ae16dd1bf03d0dbe8363dab3ecdaf427f47a4244561ff50d1f268d6fd29e90a`.
- Both were independently decoded with Pillow in addition to the bounded runner decoder; markers and receipt/image byte hashes match. Inspection shows the intended Studio courtyard composition and changed shell finish. 34,242 RGB pixels differ; unchanged pixels are not required because rendering includes dithering/reflections. This is not a pixel-accurate segmentation assertion.
- `http-evidence-005/` proves real Node middleware delivery, A→B→A identical Obsidian bytes, duplicate pending Bronze requests sharing one capture, successful service restart, initial cache-index reconstruction from the retained successful retry and unsupported-design HTTP 422. No renderer was invoked for A's cache hits or restart.
- `actual-pair-verification.json` records independent inspection and preservation checks. The ledger contains **five attempts: three failed, two successful; all three diagnostic retries consumed**. All six files from the original three attempts retain their approval-time hashes. No lock/owned browser remains. Successful samples must not be rerendered implicitly.

The initial cache-only measurement was **8.0–9.0 seconds** for submit plus image retrieval on loopback: the service rebuilt its manifest/bundle on both requests. The service now retains one prepared closure and revalidates its original source/asset/resource bytes before reuse, rebuilding only when validation fails. Metadata deadlines refresh per serialized operation; artifact decode/hash/receipt checks are unchanged. Source-change, tamper and expired-first-deadline tests cover the reuse path. See `cache-only-timing*.json` for before/after observations; these are not browser display, network-profile or p95 measurements.

After that correction, three cache-only observations were **5.48 seconds cold-service, 0.842 seconds warm Bronze, 0.842 seconds warm Obsidian** for submit plus verified PNG retrieval. The first request still prepares the current build; later operations validate unchanged bytes without rebuilding it. Zero captures occurred and all history hashes remained unchanged. These observations establish neither first-open instant display nor the proposed p95 target.

The subsequent cache-only browser pass exercised the exact Obsidian→Bronze→Obsidian pair in the B-based UI at 1440×900, 1280×800 and 1536×960. Genuine responses were deliberately delayed to check pending editing, save/share/JSON export, read-only plan, Undo/Redo and out-of-order response fencing; these delays are not performance measurements. Unsupported Olive displayed no current PNG and recovered to Obsidian. Six inspected PNG deliveries matched the original bytes; nine observed artifact replies reported verified exact hits. The recording, screenshot pair and integrity evidence are retained in the local UI handoff. No capture callback, new history entry, source repair or substitute imagery occurred.

**Outstanding:** pale pending/unavailable explanatory text needs contrast review; corrupt-image/decode and transport-failure injection, clipboard permissions and share-link reopening were not exercised in this pass. Final visual quality (these previews are visibly rough), production/laptop speed, broader views/product coverage, art/rights/engineering approval, renderer comparison, strict exports and 360 remain unqualified. No deployment, paid compute or default-route cutover occurred.

## Prior blocked checkpoint: before the approved fourth attempt

The following describes the retained pre-approval checkpoint, not the current result above.

The contract/build lanes did not render. Integration and parent diagnosis ran one real loopback HTTP submission and **two bounded diagnostic retries**, all for `studio-20-front-left-wide` (Obsidian). All three failed. Bronze was not attempted, and no successful cache entry or PNG was produced. The requested real-image pair, finish comparison, independent image decode/hash verification, ready-image HTTP delivery, exact-hit/restart cache proof and A→B→A image proof remain **unverified**. Synthetic tests are not substitutes.

Evidence is retained outside source under `/home/ubuntu/Documents/fury-real-handoff`:

- `http-evidence-001/`: actual unsupported-design rejection and duplicate interests sharing the same capture binding, followed by truthful nonretryable `capture-failed`. This establishes failed-work coalescing only, not successful image reuse.
- `local-render-capture-dad5f025-40fc-4e53-ac33-45d18da52ee5/failure.json`: initial `scene-failed`, 7,983 ms, no page requests or runtime observations. Browser stderr was reduced to an insufficient fixed diagnostic vocabulary; its exact startup error was not retained.
- `diagnostic-capture-002/failure.json` and `cleanup.json`: after a focused short owned TMPDIR correction (the former deep output/profile TMPDIR exceeds Linux's Unix-socket path capacity), Chrome **137.0.7118.2**, **WebGL2 / software / ANGLE SwiftShader** initialization and 53 local requests are observed. The job fails `scene-failed` after 5,609 ms, with last progress **assembling**, zero rendered frames, and no warming/encoding. Cleanup confirms the owned process was killed. No graphics unavailability, memory exhaustion or timeout was proven.
- Attempt 02's early `browser.runtime.effects` entries describe intended profile behavior, **not completed effects**; that immutable failed receipt is not a successful render receipt. Subsequent code records initialization fields separately as `initializedRuntime`, excluding effect claims, and adds allowlisted CDP-method/worker-failure and assembly-stage diagnostic codes.
- `diagnostic-capture-003/failure.json` and `cleanup.json`: the final diagnostic retry observes **root configured, scene mounted, architecture checked**, then fails at **`cdp-command-failed:Fetch.enable`**, after 5,400 ms. No frame was rendered. The owned browser was terminated and cleanup confirmed. This identifies a capture-controller failure, not a demonstrated graphics-resource shortage.
- The controller had incorrectly sent `Fetch.enable` to a dedicated-worker target. The correction installs browser-wide Fetch interception before creating any page; dedicated workers retain paused startup and Network/Runtime observation without the unsupported command. Exact URL/method/redirect/auth restrictions remain; interception is not disabled. Chromium's [worker interception test](https://github.com/chromium/chromium/blob/137.0.7118.2/third_party/blink/web_tests/http/tests/inspector-protocol/fetch/worker-interception.js) uses this browser-target arrangement. Synthetic regression coverage includes worker-target rejection of Fetch, browser-wide request admission/denial, and ordering before target creation. **No actual capture has exercised this correction yet.**
- `integration-source-freeze*.json` records source/asset/build closure and unchanged legacy renderer identity `0db345d223`. The service uses a trusted extensionless-TypeScript loader, fixed worktree/history paths, and private source graph admission; the earlier paused import/root issues are resolved for the exercised CLI/service path.

The controller correction is **not yet runtime-verified**. Do not call this a GPU-resource blocker or claim a GPU run will fix it. The retained ledger has three failed attempts, zero successes and **both diagnostic retries consumed**. Further retry requires explicit authorization to extend that limit; do not reset history, create a new principal, alias the failed sample or spend a fresh Bronze attempt to evade it. Only after a successful Obsidian capture should Bronze and successful-byte HTTP/cache verification proceed. A hardware/backend change would require separate scope/profile/contract approval, not a silent fallback. All G1, art/rights/engineering, production-speed, strict/Cycles and 360 gates remain closed. No customer app server or UI browser testing occurred.
