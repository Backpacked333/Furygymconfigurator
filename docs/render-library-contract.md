# Render library v1 integration contract

## Camera-visible representatives (`camera-visible@1`)

Set identities version the mapping from a requested build to its five photographic
representatives. Image identities still bind the **complete representative design**
and `fury-native-five@2`. We never omit fields from an image hash while rendering the
unmodified request. TypeScript `viewDesign`, native preparation, SQL publication
validation and Python `view_design` must agree.

This is a presentation policy, not proof that occluded surfaces cannot affect indirect
light. A changed room can subtly change a historical rear photograph. Those historical
images are not byte-equivalent aliases and must not be relabeled. Only an existing image
of the exact canonical representative and recipe is reusable. Its original publishing
set, URL, SHA, receipt and provenance remain unchanged.

| Camera                                    | Room wall, floor, mirror                                         | Exterior choices                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Front-left, front, left                   | Preserve: glazing/openings, reflections and transmitted light    | Preserve                                                                     |
| Rear-left, studio day/night, no add-ons   | Canonical gallery wall, rubber floor, no mirror                  | Preserve size, finish, accent, opening, infill, door pose, integrated finish |
| Rear-left outdoors or with **any** add-on | Preserve: scenery/add-ons can reflect the room; framing can move | Preserve                                                                     |
| Entry                                     | Preserve                                                         | Existing interior representative: obsidian, no accent/add-ons, glass railing |

All cameras retain scene/look, day/night, aspect, family/size, arrangement and output
profile. Railing becomes glass when neither roof nor stairs exists: no railing
geometry is constructed in that case. Keep it when either exists. The five-image
customer pipeline has **no independent rear image**: legacy `rear` maps to rear-left,
`top` maps to front-left, and `centre`/`back` map to entry. Arbitrary gallery cameras
are not newly qualified by this policy.

The audit sources are `architecture.ts` (opaque rear shells versus front glazing),
`addons.ts` (railing consumers), `unitParts.ts`, `gallery.ts` (obstacle-aware framing),
`nativeCamera.ts`, and native scene preparation. Part-list scopes alone are not a
ray-tracing visibility proof. Unknown dependencies stay in the key.

### Simultaneous requests

Global image lookup alone only prevents duplicate work **after publication**.
`202610210001_image_singleflight.sql` also prevents two active dispatches owning the
same still-missing image. The existing transaction advisory lock serializes claims.
An uncertain provider outcome keeps ownership until publication or confirmed
reservation settlement; elapsed time or a stale lease is not proof that it stopped
rendering. An unrelated job can use the other lane. A waiting job claims only remaining
images after the first publishes. An entire overlapping job waits rather than risk
spending twice on a shared view. Existing lane quotas and foreground ordering remain.

### Coordinated rollout (not a frontend-only change)

1. Preserve and pause campaign admissions; keep the old interactive pipeline working
   while packaging/testing. Do not restart the old campaign driver unchanged.
2. Prepare a new immutable Vast CPU/preparation and GPU worker build from the exact
   reviewed source. Retain qualified binaries, 1,024 samples, OptiX, dimensions,
   denoising and WebP 95. No Modal path or paid duplicate test render is needed.
3. At cutover, briefly hold admissions and drain active work and uncertain liabilities.
   Preserve journals, delivery spools and all historical rows.
4. Apply the queue-pause migration (also in PR #46) before single-flight. Apply
   `202610210002_camera_visible_views.sql` with the matching API and worker registration
   while held. Parked old-version claims must **not** go to the new worker: use existing
   audited lifecycle operations and replan their immutable designs. Never rewrite stored
   identities or fabricate terminal evidence.
5. Verify cached canonical reuse, a meaningful non-reuse, claims, receipts and artifact
   integrity. Offline self-tests compare entire native scene-manifest hashes across two
   room designs; SQL and Python parity tests cover every customer camera.
6. Replan against saved keys, then resume Studio day, Courtyard day, Courtyard night.
   Keep foreground requests ahead of bulk. Backyard remains unsupported; no Campus
   substitution.

Merging without the coordinated worker cutover is unsafe: the old Python worker
correctly rejects `camera-visible@1` set identities. No historical row mutation,
approximate image match or receipt rewrite is part of this rollout.

### Read-only bulk planner

```sh
node --import ./scripts/native-render-register.mjs scripts/native-render-plan.ts designs.json saved-image-keys.json > plan.json
```

Both inputs are JSON arrays: valid customer design envelopes and **actual saved**
`img_...` keys from a fresh inventory. Do not project historical rows into new keys.
The planner skips duplicate builds, saved builds and builds covered entirely by earlier
planned views; it counts unique missing images and records cross-set dependencies.
It orders Studio day, Courtyard day, Courtyard night and defers other looks.
It does not admit jobs, spend money or modify a queue.

Before admission, compare the live lookup identity to the planned identity and stop on
any mismatch. Recheck coverage; a planned artifact is not a saved artifact. Keep
idempotency keys, hourly/budget limits and a bounded queue. Do not admit builds marked
`covered-by-planned-views`; look them up again when their dependencies finish, and
replan if a dependency failed. Queue single-flight remains the authoritative guard
against overlapping concurrent work, including interactive requests.

## Original integration scope

This is a contract and compatibility implementation, not an enabled service. No route here queues work, no provider is contacted, and no budget is provisioned. `/` remains v3; `/?experience=library` remains the explicit native preview. Future builders must fail closed until their real adapters are installed. Do not attach the retired gateway, P04 fake renderer or browser scene capture to this API.

## Ownership and imports

- Shared, frozen after the integration push: `src/render-library/{contracts,identity,views,workerProtocol,seedManifest}.ts`, JSON fixtures, `src/domain/presentation.ts`. Ask the integrator for extensions rather than diverging wire contracts.
- UI builder: `src/prototype/`, UI usage in `src/components/`, `src/App.tsx`, styles/CSS and client tests. Call `normalizeCustomerDesign` at share/save/load/history boundaries; use `CUSTOMER_CAMERAS` (five), **not** `DRAFT_CAMERAS` (seven historical). v3 uses `customerAngle` (also handles rear/back). Keep parsers/resolvers lossless. New v4 defaults are Studio Day; v3 must apply Studio Day only in its **new design** initializer, not by overriding restored config. No extra customer time slider. UI owns both routes' five-view/theme integration.
- Service builder: `api/`, `src/render-library/server/`, `supabase/` migrations, service tests/docs. Expose the API below; no remote SQL/provisioning in this workflow.
- Worker builder: `render-server/fury_render/on_demand/` (or separate `render-server/on_demand/`), `scripts/native-render-*` (except the shared fixture generator), worker tests/docs. Expose the worker protocol; do not modify UI or add cloud wiring elsewhere.
- Integrator alone owns package/lock/config changes. No new dependency was required here. Keep server/worker modules out of customer bundles; import browser-safe modules directly, never a server-exporting barrel.

## Identity and release

`computeSetIdentity(input): Promise<SetIdentity>` first validates `customerDesignSchema`, then canonicalizes the existing `serializeDesign(parseDesign(input))` result. Sorted UTF-8 JSON binds `contractVersion`, `kind`, full design, and the complete immutable `RECIPE_RELEASE` object. SHA-256 keys are `set_<hex>` and `img_<hex>`. Set payload deletes **only** `presentation.cameraRef`. Image payload keeps it. Addons retain the domain parser's canonical ordering. Fixed arrangement, door pose, landscape/look, lighting, aspect, profile, all options and recipe release remain bound. Client keys are advisory and never accepted by admission requests.

`fury-native-five@1` is a reserved immutable source-release name, **not yet registered or approved for execution**. Before activation the operator/service must pin it once to actual geometry, materials, camera, renderer, worker and complete recipe-bundle SHA-256s in `render_library_recipes`. Every worker claim/receipt must match those hashes. Missing registration disables admission. Changed sources require a new release and new keys, never updating the row or ignoring version mismatches. This stage does not assert that outdoor conversion or corrected studio worker code already exists.

Five ordered views: `front-left-draft@1`, `front-draft@1`, `left-draft@1`, `rear-left-draft@1`, `entry-draft@1`. Full catalog retains elevated/centre and v3 rear/back diagnostics. Native masters are 1920×1200 wide and **1200×1500 tall** (4:5, not a crop). Exactly 1024 completed non-adaptive samples, L40S/Cycles/OptiX, WebP quality 95. New-look default never overrides restored outdoor/Night choices.

The historical `studio-neutral-draft@1` parser/resolver remains valid; explicit customer-load normalization maps that old noon Studio alias to Studio Day. Public render requests require one of the eight Day/Night looks and one of the five cameras. The JSON Schema projection restricts these enums too.

## HTTP (JSON, `Cache-Control: no-store`)

`contracts.ts` exports Zod request/response schemas and inferred types. `fixtures/http-contract.json` has complete canonical payloads and keys; `schemas.json` is their JSON Schema projection. Zod refinements and DB transactional invariants remain normative where JSON Schema cannot express cross-field checks.

| Endpoint                                     | Input                                                                                      | Output / semantics                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/render-library/lookup`            | `LookupRequest {contractVersion, design}`                                                  | `LibraryResponse`; **read-only**, never reserves, creates outbox entries or dispatches                                                      |
| `GET /api/render-library/session`            | none                                                                                       | `sessionResponseSchema`; signed HttpOnly Secure SameSite cookie plus short-lived CSRF token; never admits GPU work                          |
| `POST /api/render-library/jobs`              | `CreateJobRequest {contractVersion, design, intent:'render-missing', idempotencyKey:UUID}` | `LibraryResponse`; explicit click only; selected `design.presentation.cameraRef` has priority; requests only this exact set's missing views |
| `GET /api/render-library/jobs/:jobId`        | UUID                                                                                       | `LibraryResponse`; read-only durable status, usable after reload                                                                            |
| `POST /api/render-library/jobs/:jobId/retry` | `RetryJobRequest {contractVersion, intent:'retry-failed-missing', idempotencyKey:UUID}`    | explicit retry only after provider terminal safety, for failed missing views; never rerender cached views                                   |

Successful lookups/status are HTTP 200. New durable admission is 202; joins/cache/idempotent returns may be 200. Invalid input 400, origin/CSRF 403, missing job 404, idempotency/unsafe retry 409, budget/rate/capacity 429, configuration/provider/lookup unavailable 503. All failures use `{contractVersion,status:'error',error:{code,message,retryable}}`; messages are allowlisted user-safe copy, not raw provider/database/credential errors. Failed lookup is **not** `coverage:'missing'`.

Cost-producing requests require matching allowlisted Origin, Fetch Metadata validation where present, session-bound `X-CSRF-Token`, JSON content type and bounded body size. Creation cannot accept client costs, keys, status, receipt, executable, scene, URL or provider parameters. Network/session rate limits plus a global budget/concurrency ceiling must be transactional, not per-process maps. An unavailable response must not pretend a job is queued. Static seed reads must work without provider/service credentials.

`SetSnapshot` always has five unique views, exact `SetIdentity`, authoritative `coverage`, optional durable `job`, and `rendering` availability. Ready images use `ImageDescriptor`; pending states are queued/preparing/rendering/saving/verifying. Terminal jobs are complete/failed/blocked/dispatch-uncertain. Per-image progress is indeterminate; `completedImages/5` counts verified ready views including seed hits. No sample percent, synthetic timer or ETA is part of this contract. Select completed cameras while remaining views run. Preserve job ID locally only as a pointer; DB remains authority. Changes to design do not cancel shared work and stale status must never overwrite a new set/image identity.

## Seed cache compatibility

`server/seedCache.ts` accepts only the exact 400-image manifest bytes with SHA-256 `f56574f571761b2ed3357e369d784c37318c900f0e2dc0a973a3d7a3c0a83e54` and revision `539b3c8b7cf3447cc331bcce0e2ae457d65237d1e04ce567c344941cdb15160b`. It recomputes every historical `requestKey` from `serializeDesign`. The compatibility rule `native-library-400-exact@1` permits **only those enumerated historical artifacts for identical complete requests** within the new set grouping. This is a finite import exception, not recipe-version equivalence. No old receipt/image is changed; original per-image recipe, manifest and worker digests are retained in discriminated `seed-cache` provenance. The new release names the serving identity; the provenance states which historical release actually made the image.

Five Studio Day views per existing build are imported. Night has only its historical hero (1/5). Elevated/centre bytes stay preserved but are not customer set members. No outdoor/tall/modified-design substitution, no paid backfill. Changes to the manifest or release require a reviewed new compatibility rule. Importer must verify actual bytes/checksum/format/dimensions before durable publication; browser independently verifies delivery. `verifySeedManifest` alone is metadata verification, **not** evidence that image bytes decoded.

## Database and RPC

`server/ports.ts` defines `RenderLibraryRepository`, `RenderLibraryService`, `RenderDispatcher`, `ImmutableArtifactStore`, and `RenderLibraryRpc` (exact SQL argument/result keys). `server/databaseContract.ts` and the generated `database-contract.json` define table names/columns, unique constraints, RLS and transactional invariants for the migration builder. No migration has run here.

`render_library_reserve_set({command})` locks the approval ledger, set, relevant images and session/network admission state in a consistent order; validates expiry/enablement/recipe registration; imports verified seed hits; joins existing work or reserves startup plus the bounded missing-image worst case and writes job/job-images/idempotency/outbox atomically. The total includes all startup, execution, CPU preparation, storage and provider liability at an operator-specified conservative upper rate. Reject if the bound or any configuration is absent; the historical $50 experiment is not a budget. A cache hit or shared join reserves no new GPU liability. Prior reservations remain liabilities until settled.

`render_library_claim_dispatch({dispatcherId})` atomically moves ONE pending outbox to dispatching and returns `{dispatch,claimToken}`. Dispatcher sends exactly once, then `render_library_record_dispatch({dispatchId,claimToken,result})`. `accepted` records provider call ID; `definitely-not-submitted` requires proof no submission occurred; any timeout/crash/uncertain result stays reserved and cannot be re-sent. Never reclaim dispatching work by TTL. Durable worker claim allows at most one execution even on duplicate provider delivery. Choosing safety over availability means crashes can require operator reconciliation.

`render_library_claim_worker({dispatch,workerBuildSha256})` validates the registered worker and claims exactly once, returning `WorkerClaim|null`. `render_library_record_event({event})` dedupes event IDs and sequences and fences stale attempts; it does **not** publish images. `render_library_publish_asset({jobId,attemptId,fence,artifact})` is service-only after independent validation, binding both job and image. `render_library_reconcile_terminal({jobId,evidence,chargedMicroUsd})` requires authenticated provider-terminal or never-submitted evidence. Worker “failed”, elapsed wall time or loss of lease alone cannot free liability or make a retry safe. `render_library_retry_failed(...)` then creates a new bounded attempt/job only for safe missing images. Retain completed images and terminal errors.

## Worker adapter

`WorkerServicePort` fixes the private HTTP adapter signatures: `claim(ClaimRequest): Promise<{claim:WorkerClaim|null}>`, `prepareUpload(ArtifactEvent): Promise<UploadTicket>`, `recordEvent(WorkerEvent): Promise<{accepted:boolean}>`. All three are POST with server-provisioned `Authorization: Bearer` worker-service credentials, never browser cookies/CSRF. Missing/invalid worker authorization is HTTP 403 with the public-safe error envelope; contract/binding errors are 400, duplicate already-claimed dispatch returns `{claim:null}` without executing work. Do not log headers or signed URLs. Operator provisions these credentials separately; no default token is allowed.

- `/api/render-library/worker/claim`: body `claimRequestSchema` (dispatch identifiers + workerBuildSha256), response `claimResponseSchema`. An ambiguous claim response is not permission to execute; never retry with a new dispatch ID.
- `/api/render-library/worker/uploads`: body `artifactEventSchema`, response `uploadTicketSchema`. Validate current attempt/fence, claim, recipe and receipt first. Return a short-lived, exact-object signed upload to private bucket `render-library-staging`, no overwrite, byte limit <= receipt bytes <= 8 MiB. Worker parent checks configured Supabase origin and `stagingObjectKey(receipt)` before upload; never pass this URL or credentials to the renderer child. Reissuing the same scoped upload ticket may not start GPU work or accept different bytes.
- `/api/render-library/worker/events`: body `workerEventSchema`, response `eventResponseSchema`. For `kind:'artifact'`, service fetches the deterministic staging key (not a caller URL), independently validates bytes/decode/provenance and publishes immutable metadata, then acknowledges. Worker sends the same eventId on metadata-delivery retry, never rerenders. A terminal event is not billing reconciliation evidence. Complete may only follow five durable ready images. Future adapters must quarantine stale/invalid staging uploads and bound staging retention.

`server/validation.ts` exports `verifyWorkerClaim(input,registration)` and `verifyArtifactReceipt(input,claim)` for recomputing canonical bindings. These are metadata checks, not a replacement for independently decoding pixels or checking provider termination. Supabase staging writes are signed narrowly; only the service writes the public `render-library` bucket. Image bytes go direct to Storage, not through a serverless JSON/base64 payload.

`workerProtocol.ts` is the normative Zod protocol. `fixtures/worker-adapter.json` is explicitly **test-only**, with synthetic worker hashes/receipt metadata, no image bytes. `DispatchEnvelope` contains **only** contractVersion, jobId and dispatchId; a browser cannot submit a design/scene directly to Modal. The private worker retrieves its trusted design, exact missing view/image keys, recipe/build pins, fence and deadline from claim. It renders selected view first if missing, then remaining canonical order. A native render receipt includes full design, exact image key, recipe/build/scene/camera hashes, byte checksum/length/dimensions, device and completed sample evidence.

Native child execution must drop root, strip service/GPU credentials, restrict network, allow only pinned code/assets, enforce preparation/image/job deadlines, and prohibit CPU rendering fallback. One job is at most five images; min containers 0, max 2, concurrency 1 each, provider retries 0. Hard limits are exported in `EXECUTION_LIMITS` (startup 180s, prep 120s, image 300s, job 2100s). Include provider startup outside the execution timeout in the reserved bound. No automatic provider retry even after a partial job. Render the actual selected environment/day-night; unsupported conversion returns `unsupported-scene`, never studio under another label.

Worker uploads bytes through a private service adapter. The service, not a receipt assertion, verifies bounded byte stream, WebP decode, expected dimensions, SHA-256, exact design/key, actual registered worker/recipe and complete samples before creating immutable object `{setKey}/{imageKey}/{sha256}.webp` in bucket `render-library`. No overwrite/upsert. Only afterward publish descriptor and count ready. `verifyImageDescriptor(input,wantedDesign,allowedStorageOrigins)` verifies serving binding/host before client fetch; client must still verify checksum, cap, decode and dimensions before display/download. Never mark draft images visually/engineering qualified or strict reference.

## Offline verification

```sh
node --import ./src/render/prototype/register.ts scripts/native-render-contract-fixtures.ts
npx vitest run src/render-library
python -m unittest discover -s render-server/on_demand/tests -p 'test_contract.py'
npm run typecheck
npm run lint
```

The fixture generator is pure contract/metadata work; it does not invoke the private renderer despite reusing its existing Node TypeScript resolver. The worker contract Python test needs only the standard library. No new dependency, provider SDK or credentials are required. UI runtime integration, durable service/migration/dispatcher and native worker implementation are separate builder tasks, not claimed complete by this preparatory commit.
