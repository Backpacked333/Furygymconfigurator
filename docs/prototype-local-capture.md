# DRAFT private local Three capture — contract and implementation

## Status and non-goals

**P03 update:** [configuration-only preparation](p03-private-preparation.md) now binds the complete shared private scene recipe, the actual private build, pinned assets and all 28 case-specific manifests. This lane builds/prepares only. Its source/handoff roots are `fury-p03` / `fury-p03-handoff`; the existing real-image service and capture history remain on their original roots and retain their old identities. No P03 capture or new retry is authorized. The sections below retain historical capture-operation details, not instructions to execute a new run.

The private capture, service and configurator integration now has **two actual independently decoded PNGs**, Obsidian and Bronze. After three failures, Roy authorized one extra diagnostic retry; the browser-wide interception correction then succeeded, followed by Bronze. See [current real-slice evidence and limits](local-real-image-slice.md#actual-integration-status-two-real-pngs) for actual bytes, HTTP/cache proof and limitations. The contract and lane notes below describe the original implementation requirements; their original two-retry ceiling is superseded by that single approved extension to three. All other limits remain unchanged. `ready` in the page protocol means the private interface loaded, not that a graphics backend works.

This advances original-plan P03 privately. It does not select a G1 winner, approve product/arrangements/materials/looks/cameras/assets/rights, establish visual parity or qualify performance. Four fixed arrangements and all ceiling/door/access/engineering holds remain. The historical stills (`97f204ffff`) versus current legacy scene (`0db345d223` in the prior integration receipt) mismatch remains explicit. No historical still is renamed or used as a capture. Strict Cycles 1,024-completed-samples/pixel reference, paid execution, production publishing and application-browser acceptance remain separate and unexecuted.

Ordinary prototype mode remains mock-only; the separate opt-in local-real mode connects the private Node capture service to the same B-based UI. The prior preserved real-image browser flow passed at all three laptop sizes using only existing captures; P03 does not rerun it. Default v3 behavior, retained previous receipts and `/home/ubuntu/Documents/fury-next` are untouched. No private capture imports may enter customer, mock-service or production bundle graphs. No branch changes, commits, pushes, PRs, deployment, providers or production cutover are authorized here.

## Inspected implementation and tooling

- `src/components/Scene.tsx:424–489` composes `Atmosphere`, `Landscape`, `StudioModel`, interior/site probes and `RenderEffects`. **Do not mount Scene itself:** it includes free controls, app status/UI, device rebuilds and the legacy capture/export graph.
- `src/components/StudioModel.tsx:97–129` uses the real `UNIT_LISTS`, `InteriorLights`, mirror, signature canvas, fixed equipment and sauna lights. Reuse it with `projectDesignToConfig(validatedDesign)` and fixed `quality="lite"`; do not take mutable v3/app state. `src/domain/design.ts:243–276` explicitly projects every field and derives fixed equipment from authority.
- `src/components/Atmosphere.tsx:152–407` provides authored sky/PMREM/site illumination, sun/moon and exposure; `src/components/InteriorProbe.tsx:194–227` supplies four interior captures and one exterior probe. `src/components/Landscape.tsx` supplies the authored setting, ground and vegetation. These are browser resources, not the CPU material holders.
- `src/components/RenderEffects.tsx:10–70,279–408` imports cloud clients, baked lookups, prefetch/still sessions and tracing. **Do not import RenderEffects**, even with `trace=false`; reuse `createPipeline` from `src/render/pipeline.ts:148–174` in a small private bounded frame driver instead. Lite is a 4x-MSAA TSL scene pass with AgX/sRGB/dither; no GTAO, SSGI, SSR or bloom. `src/render/mirror.ts:18–23` makes Lite's mirror probe-lit metal, **not** planar reflection. These omissions/approximations must be visible in each runtime receipt.
- `src/render/renderer.ts:88–109` creates the WebGPURenderer and WebGL2 fallback, initializes rectangular-light LTC tables, and includes the Chrome texture-view shim. `beginFrame` advances stopped renderer node state. `requestedBackend` (`src/render/quality.ts:9–12`) reads the page query: only an operator-owned fixed private page URL may select the backend; never pass caller queries through.
- Material loading is not proven by a full progress bar: `src/render/materials.ts:253–280,308–312` counts failed scans as settled. Check required materials with `whenMaterialLoaded`/`materialLoaded`, observe failures and validate the server's actual asset bytes. Fail `asset-failed` instead of rendering untextured placeholders. The loader has internal retries and delayed waiting; an outer independent deadline is mandatory.
- `src/render/siteLightNode.ts:114–142` creates a local module worker and answers only its latest ticket. The built worker must be included in the trusted bundle closure/allowlist and its completion tracked. Frame-count-only readiness does not prove this field or asynchronous probes/textures are ready. A missing/unobserved site field must be reported as omitted/approximate, not quietly asserted enabled.
- The CPU adapter's `register.ts` rewrites browser material imports and stubs console canvas. **Do not load that register hook, `prepare.ts`, `fixtures.ts` or `materialCapture.ts` in the new page.** Samples here reuse `domain/designFixtures.ts` directly, avoiding the Node/CPU preparation graph.

Installed tools were inspected without launching a browser:

- Node: `/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node`, verified `v24.22.0`; built-in `WebSocket`, Web Crypto and Node zlib are available.
- Actual installed executable: `/opt/.devin/chrome/chrome/linux-137.0.7118.2/chrome-linux64/chrome`. Its directory also contains `libEGL.so`, `libGLESv2.so`, `libvk_swiftshader.so` and `vk_swiftshader_icd.json`. Existence is **not** evidence of a working backend. Runtime version/adapter strings must be measured by the runner/page.
- Avoid the PATH shim `/home/ubuntu/.local/bin/google-chrome`: its bare-URL path opens the existing desktop browser. Launch the absolute executable only, headless, with a new owned disposable profile and a new owned debugging endpoint/pipe. Never reuse the existing Chrome, profile or CDP port.
- Project resolution finds Vite, Zod, TypeScript, Vitest and `ws`. Playwright, playwright-core, Puppeteer, puppeteer-core, pngjs and sharp are **not resolvable** from this worktree. `node_modules` is a shared symlink through fury-next to the existing dependency tree; do not install into it. A small native Node WebSocket/CDP client needs no new package. A robust bounded Node PNG decoder can use zlib (RGB/RGBA8 non-interlaced PNG plus CRC/filter checks); alternatively report a specific pinned development dependency to the integrator for isolated install/lockfile review, never assume one exists.
- Software-rendering route to diagnose first: private page fixed to the WebGL2 backend and owned Chrome launch with SwiftShader/ANGLE flags. Those flags are proposed, **not tested**. A separately bounded WebGPU/software diagnostic is possible within the same two-retry budget. Record the actual API and software/hardware/unknown adapter provenance; unknown is not hardware. Nothing here measures a laptop or physical GPU.

## Frozen contract

Import only `src/render/prototype/capture/contract.ts` from the private scene/runner lanes. It uses strict v4 domain parsing and existing logical identity plus the pure authored `galleryCamera`; it introduces no competing product catalog.

### Exports

Constants: `CAPTURE_PROTOCOL`, `CAPTURE_FLAGS`, `CAPTURE_LIMITS`, `LOCAL_REVIEW_PROFILES`, `SAMPLE_IDS`, `CAPTURE_FAILURE_CODES`, `CAPTURE_PHASES`, `CAPTURE_EFFECTS`, `WORKER_GLOBAL`.

Schemas: `digestSchema`, `captureProfileSchema`, `captureRequestSchema`, `captureBuildSchema`, `captureSampleIdSchema`, `captureJobSchema`, `captureProgressSchema`, `captureRuntimeSchema`, `captureCameraSchema`, `captureFailureSchema`, `workerResultSchema`, `workerReadySchema`, `pixelEvidenceSchema`, `captureArtifactSchema`, `captureReceiptSchema`, `captureCompleteSchema`, `captureTerminalSchema`, `captureAttemptSchema`.

Types: `CaptureProfile`, `CaptureRequest`, `CaptureBuild`, `CaptureSampleId`, `CaptureJob`, `CaptureFailureCode`, `CaptureProgress`, `CaptureRuntime`, `CaptureCamera`, `WorkerResult`, `WorkerReady`, `CaptureWorkerPage`, `PixelEvidence`, `CaptureArtifact`, `CaptureReceipt`, `CaptureComplete`, `CaptureTerminal`, `CaptureAttempt`. `CaptureContractError` carries a typed `code`.

Functions:

```ts
parseCaptureRequest(input: unknown): CaptureRequest
parseCaptureRequestText(text: string): CaptureRequest
createCaptureSamples() // six review samples plus the retained Bronze comparison
captureIdentity(input: unknown, buildInput: unknown) // async logical + capture digests
createCaptureJob(jobId: string, sampleId: CaptureSampleId, input: unknown,
                 buildInput: unknown): Promise<CaptureJob>
validateCaptureJob(input: unknown, expectedBuild?: CaptureBuild): Promise<CaptureJob>
resolveCaptureCamera(input: unknown): CaptureCamera
validateCaptureProgress(input: unknown, job: CaptureJob,
                        previous?: CaptureProgress): CaptureProgress
parseCaptureRuntime(input: unknown): CaptureRuntime
validateWorkerReady(input: unknown, expectedBuild: CaptureBuild): WorkerReady
validateWorkerResult(input: unknown, job: CaptureJob): WorkerResult
assertCaptureActive(signal: AbortSignal, nowMs: number, deadlineMs: number): void
assertCanStartAttempt(historyInput: unknown, sampleId: CaptureSampleId,
                      kind: CaptureAttempt['kind']): void
inspectDecodedPixels(profileInput: unknown, width: number, height: number,
                     rgba: Uint8Array | Uint8ClampedArray): PixelEvidence
validateDecodedArtifact(profile: CaptureProfile, bytes: Uint8Array,
  decoded: { width: number; height: number; rgba: Uint8Array | Uint8ClampedArray }
): Promise<CaptureArtifact>
validateCaptureReceipt(input: unknown, expectedJob: CaptureJob) // async frozen receipt
validateCaptureTerminal(input: unknown, job: CaptureJob): CaptureTerminal
```

Schemas check shape; **use the validation helpers** to recompute binding, enforce pinned compositions and compare page/runner metadata. They do not authenticate a local caller or enforce filesystem/network safety. Invalid Zod/JSON admission errors must be mapped to `invalid-input`; unexpected runtime exceptions to `scene-failed` with bounded sanitized messages, never raw environment/headers/secrets.

### Exact data responsibilities

- `CaptureRequest = { protocol, design, profileId }`. Design is the full strict v4 envelope. There are no URLs, filesystem paths, arbitrary meshes/equipment, scripts, shaders, custom camera coordinates, exposure controls or sample settings. The operator selects a fixed profile matching the design aspect; it cannot resize it.
- `CaptureBuild = { sourceManifestDigest, assetManifestDigest, bundleDigest, lockfileDigest, threeRevision }`. Runner computes these from actual trusted bytes, not declared catalog versions. Browser sees hashes/revision only, never source paths or a caller resource manifest. Browser bootstrap metadata must be separately supplied by the trusted static server after bundle hashing (avoid a self-referential embedded bundle hash). `ready()` echoes the frozen bootstrap build; `render` validates against it.
- `CaptureJob = { protocol, jobId, sampleId, request, profile, build, identity, flags }`. Profiles/build/design are parsed copies and recursively frozen. `identity` contains domain `designDigest`, `presentationDigest`, `requestDigest`, plus `captureDigest` binding logical identity, full selected presentation, exact derived camera/lens, full fixed output profile and full build identity. Job/attempt IDs do not alter logical or capture identity. **Artifact byte hash is separate.** Different runtime devices/encoders may produce different bytes for the same logical request. Pixel sameness is never design equality or a cross-device requirement.
- Camera uses the shared `resolvePrivateThreeSceneInput` / `galleryCamera` calculation with the trusted default hero direction, feet, +Y up, near 0.1 and far 2000. P03 CPU manifests now match these same values. No free controls or inherited app camera state.
- `CaptureRuntime = { backend, acceleration, adapter, browserVersion, userAgent, effects }`. Every named effect has `state` (enabled/approximate/omitted/not-applicable) and a bounded detail. These are observations/provenance, not approvals. Success requires authored architecture/fixed equipment, real material scans, environment/fixture lighting, interior/site probes and MSAA. Applicable thin-glass/canvas/site-field limitations must be explicit. Lite mirror must not claim planar reflection; known Lite omissions cannot claim enabled.
- All relevant envelopes carry immutable false `productionAllowed`, `paidExecutionAllowed`, `strictReference`, `g1Qualified`, `visualParityClaimed`. Full verbatim `designReviewHolds` survive into the receipt.

### Page protocol

The private built page exposes only `window.__FURY_LOCAL_CAPTURE__` implementing:

```ts
interface CaptureWorkerPage {
  ready(): Promise<WorkerReady>
  render(job: CaptureJob): Promise<WorkerResult>
  progress(): CaptureProgress | null
  dispose(): Promise<void>
}
```

One render per fresh page/process; reject concurrent/repeated render calls. `ready()` only proves protocol/build readiness. CDP calls these fixed methods with JSON values, not caller-provided JavaScript; no generic evaluate endpoint. `progress()` is polled through owned CDP, monotonic with at most 128 distinct events. Phases are loading/assembling/warming/settling/encoding/validating/publishing, **never complete**. The last two are runner phases; page stops at encoding. Page success is only `state: 'captured'`, with job/capture binding, base64 PNG (not a data URL), actual camera/runtime, frame count, elapsed time and flags. Page failure is `state: 'failed'`, a typed code and bounded message, no image or completion marker.

`dispose()` is idempotent and aborts pending work, cancels timers/frame loops, unmounts/disposes owned scene resources and resolves/rejects any pending render without a ready image. Runner owns cancellation/watchdog independently: call dispose with at most 5 seconds grace, then terminate **only its owned child process group**. A blocked GPU/JS thread cannot defeat the Node deadline. Check the cancellation token and deadline after every await and immediately before/after validation and before publication; late page results are fenced out. Cancellation wins over simultaneous timeout in the helper. Do not return the last frame, a stub, a prior still or a lower-quality replacement.

## Fixed conservative review profiles and sample budget

| Profile               | Output               | Fixed settings                                       |
| --------------------- | -------------------- | ---------------------------------------------------- |
| `local-review-wide@1` | 640 × 400 PNG, 16:10 | Lite, TSL raster, DPR 1, 4x MSAA, AgX/sRGB/dither    |
| `local-review-tall@1` | 400 × 500 PNG, 4:5   | Same settings, independent authored portrait framing |

These are **not** future G1 quality profiles, strict sample counts, delivery profiles or approved product images. Both require at least eight frames, at most 64, 500 ms quiet after final required resource/probe changes and at least two post-readiness frames. Do not mistake these minimums for resource readiness. Dispose rather than extending caps or silently changing quality if the machine cannot finish.

| Pinned sample ID               | Source selection                                                                                                              | Camera / aspect   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `studio-20-front-left-wide`    | Studio 20 baseline; courtyard day; closed door                                                                                | front-left / wide |
| `studio-40-entry-tall`         | Studio 40 baseline; courtyard day; closed door                                                                                | entry / tall      |
| `container-20-front-left-wide` | Container 20 baseline; courtyard day; closed roll-up                                                                          | front-left / wide |
| `container-40-front-left-tall` | Container 40 baseline; courtyard day; closed roll-up                                                                          | front-left / tall |
| `studio-40-night-centre-wide`  | Studio 40 difficult interior; no additions; chalk/slatted/oak, mirror, sliding glass open; courtyard night                    | centre / wide     |
| `container-40-roof-top-wide`   | Container 40 full overhead-glass opening, integrated finish, cable railing, canopy/deck/roof/stairs, open door; courtyard day | top / wide        |

At most **six unique successful samples**, **two further diagnostic retries**, **eight total attempts**, **one concurrent job** across this batch; no fixture-wide sweep. A failed initial sample may be retried only as a recorded diagnostic attempt; a successful sample cannot be rerendered. `assertCanStartAttempt` checks the operator's retained history but does not persist it. Runner/integrator must retain one append-only attempt history, including failures, across invocations and output directories; new directory/process does not reset permission. Do not auto-retry indefinitely or classify missing captures as successes.

Hard bounds: startup 30 seconds; each admitted job 180 seconds **including its startup, scene, encoding, decode and publication**; cleanup 5 seconds; total run 1,530 seconds. Independent outer child deadline includes blocked operations. Max PNG 2 MiB; request JSON 20 KiB UTF-8; other individual metadata files/messages 64 KiB; browser result base64 bounded to 4 × ceil(2 MiB / 3), with bounded protocol overhead. Local individual assets max 16 MiB; total asset bytes 128 MiB; max 512 resource requests per attempt (retries count). These are admission caps, not performance targets or observed timings. Node failure elapsed time may exceed the job budget slightly to record cleanup/watchdog latency honestly.

## Offline assets and source/build binding — runner obligations

1. Build the private entry with existing Vite programmatic build using an isolated config (`configFile: false`), not the app entry/config/plugins. No dev/HMR service or mock plugin. Discover and verify the actual module graph; reject App/legacyEntry/RenderEffects, cloud/export/still/prefetch/session routes, CPU register/materialCapture/prepare, image-service and prototype UI. Trusted pure domain/config/camera code and complete browser scene builders are allowed.
2. Write all generated assets/state/output under a new owned directory **outside source** with a real, verified parent. Keep the prior CPU receipts immutable and separately versioned; do not regenerate them implicitly. Do not write into node_modules or another worktree. Source manifest records the actual source closure (including new page/runner/contract code), relevant package lock, and source/texture attribution file hashes. Hash sorted canonical records of relative trusted name, byte length and SHA-256. Include all emitted JavaScript, workers and local assets in the appropriate closure. Bundle digest is over actual emitted bundle records; it does not include its own bootstrap JSON. Retain exact manifests next to the run history, not just digest claims. Revalidate inputs before publication or render only an immutable snapshot of verified bytes.
3. Serve only pre-read, hash-verified allowlisted in-memory/static bytes from a fresh owned `127.0.0.1` listener. No arbitrary path joins, directory serving, filesystem endpoint, cloud URL, proxy, redirect or upstream fetch. Reject path traversal/encoding ambiguity/query surprises, symlink escapes and changed bytes. Bound file count, individual/total bytes and response count. Only the single private page, exact emitted modules/worker and actual authored local textures are allowed. Source credit URLs are provenance text, never fetched. Unknown requests (including unexpected fallback resources) fail the job rather than opening access.
4. Isolate browser egress before navigation using owned launch settings and **browser-target CDP Fetch interception**, covering the page, worker script and worker-originated requests. Dedicated workers do not expose Fetch: never send `Fetch.enable` to a worker session or silently ignore its failure. Keep paused worker startup and Network/Runtime observation. Deny external origins/schemes, redirects, websocket/service-worker/cloud requests, popups and downloads. Allow only exact origin plus known paths/methods, with request/byte caps. Do not rely on a permissive Vite server or page `fetch` monkey-patch as the security boundary. Add restrictive CSP (no external scripts/connect/fonts/images, no unsafe eval, workers from the exact trusted local build) and disable background networking/service workers. Generated internal canvas/blob texture handling may be allowed narrowly; caller data/blob/file URLs are never accepted. If the material decoder needs internal blob workers, bind their exact trusted implementation or use the authored main-thread decode path; document the choice.
5. Spawn the absolute installed headless binary with an exclusively created disposable profile and no inherited credentials. Sanitize the child's environment; never print secrets. No reuse/restart of existing browser/server processes. Runtime strings, exit code, bounded console/error diagnostics, actual backend/capabilities, timing and software status belong in failure/success receipts. Avoid raw page/script/stack dumps with arbitrary paths or inputs in user-facing summaries. No claim of sandboxing against a hostile same-UID process.

## Artifact validation and publication — runner obligations

Page bytes are not publication. `validateWorkerResult` validates schema/binding/camera; then decode the exact bounded PNG independently in the runner. PNG signature/IHDR and claimed dimensions alone are insufficient. Validate CRCs, chunk order/count/lengths, IEND/no trailing data, supported bit depth/color/interlace, bounded inflate length and filters; reject unsupported/animated payloads rather than guessing. An isolated approved decoder dependency is preferable to an unreviewed permissive decoder, but none may be installed into the shared symlink. Decode RGBA8 at the exact profile dimensions before invoking `validateDecodedArtifact`; **this helper is not a PNG decoder** and must never receive fabricated or page-asserted pixels. It checks header/dimensions, exact buffer length, complete opacity, at least 16 distinct RGB values, channel range ≥8 and luma variance ≥1, then computes the encoded-byte SHA-256 separately. These gross bad-pixel guards cannot detect a wrong camera/subject/composition, shading errors or quality; manual image review remains necessary and dark valid images may fail conservatively.

Build `CaptureReceipt` only from the validated job, freshly decoded artifact, checked actual camera/runtime, bounded frame/time evidence and exact `designReviewHolds`. Call `validateCaptureReceipt`. Save `image.png` and `receipt.json` exclusively (0600) in a new owned attempt directory (0700), with no overwrite/reuse even if empty/incomplete. Verify parent/directory identity; write/fsync/readback and rehash all bytes. Retain partial owned output on failure for inspection. Never delete unowned files or replace prior output.

Write `COMPLETE.json` **last**, after cancellation/deadline/source checks, with `captureCompleteSchema` including image digest/size/pixel evidence and receipt filename/length/actual byte digest. Publish from an exclusively written/fsynced pending marker using an exclusive hard link (or equivalent non-replacing primitive); plain overwrite/rename is not enough. Revalidate bytes/metadata before reporting `CaptureTerminal.state='complete'`. The marker is a local publication commit point; cancellation after that point is not grounds to rewrite a completed receipt. No marker on failure, timeout, unsupported renderer, cancelled job, decode/bad pixels, network denial, source mismatch or publication error. Reader must validate marker, receipt digest, image digest and decoded image together; marker/schema validity alone is not proof. No directory-entry power-loss durability or malicious-local-process sandbox claim.

## Per-lane ownership and implementation order

These are proposed downstream file boundaries for the integrator to assign, not files created by this contract stage:

| Lane                  | Own files                                                                                                                         | Responsibility                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract (this stage) | `src/render/prototype/capture/contract.ts`, `contract.test.ts`, this doc                                                          | Frozen schemas/profiles/sample plan, typed helpers and focused checks. Downstream lanes import; coordinate any protocol changes.                                                                                                      |
| Private scene         | `src/render/prototype/capture/scene.tsx`, `worker.ts`, `worker.html`, `scene.test.tsx`                                            | Trusted complete browser graph, exact camera/material/light/probe readiness, bounded rendering, honest runtime effects, one-shot page API/disposal. No app/RenderEffects imports; no edits to shared scene sources.                   |
| Private runner        | `src/render/prototype/capture/runner.ts`, `assets.ts`, `artifacts.ts`, corresponding scoped tests; `scripts/prototype-capture.ts` | Isolated build/graph checks, trusted file snapshots/allowlists, own CDP/browser lifecycle, network denial, independent watchdog/cancel, bounded PNG decode and exclusive marker. No shared dependency installation.                   |
| Integrator            | Assign lanes; review their changes, dependency closure and evidence; update this operation draft when actual CLI exists           | Preserve original candidate/source receipts, retain global eight-attempt budget, authorize at most the six pinned successes, report actual PNGs or failures. Do not launch the UI/testing agent or wire images into the mock service. |

Recommended sequence: freeze/import this contract → implement/test scene and runner independently → parent checks module/network/resource/publication boundaries → admit one pinned sample via the private CLI worker → bounded diagnostics if needed → remaining pinned samples only if the backend works. Any irreducible backend/material/pipeline/decoder failure blocks success with receipts; do not lower the fixed profile, invent an approved effect, accept flat diagnostic pixels, expand the sample sweep or ask for cloud fallback.

## Focused contract checks

Run from `/home/ubuntu/Documents/fury-capture`, with the explicit installed Node. No full suite/global formatting race and no app/browser render are part of these checks:

```sh
NODE=/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node
$NODE ./node_modules/vitest/vitest.mjs run src/render/prototype/capture/contract.test.ts
$NODE ./node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --module ESNext --moduleResolution Bundler --target ES2022 --lib ES2022,DOM,DOM.Iterable --allowImportingTsExtensions --resolveJsonModule --esModuleInterop --types vite/client,node --noUnusedLocals --noUnusedParameters src/render/prototype/capture/contract.ts src/render/prototype/capture/contract.test.ts
$NODE ./node_modules/eslint/bin/eslint.js src/render/prototype/capture/contract.ts src/render/prototype/capture/contract.test.ts
$NODE ./node_modules/prettier/bin/prettier.cjs --check src/render/prototype/capture/contract.ts src/render/prototype/capture/contract.test.ts docs/prototype-local-capture.md
```

Latest contract-stage result: **1 test file, 25 tests passed**; the scoped TypeScript, ESLint and Prettier checks above all exited 0. The first scoped TypeScript attempt omitted the Node ambient types needed by the test and also caught widened profile literal types/read-only mutation in the test; the profile declaration/test were corrected and the explicit `vite/client,node` command above passed. No package installation was needed.

The tests use in-memory synthetic PNG/pixel fixtures explicitly labelled test-only; these are not scene images or rendered evidence. Their results prove contract validation, not engine availability, asset rights, subject correctness, quality, performance, exclusive-filesystem implementation or live network isolation. Scene/runner lanes must test and demonstrate their own implementations.
