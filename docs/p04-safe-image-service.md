# P04 safe image service and cost controls

## Status and scope

**Local diagnostic implementation only. Production cutover is blocked. Paid execution is permanently disabled in this phase.** No provider, deployment, renderer, rights, contract or art approval is implied by this document or passing tests. The default v3 entry, actual B image UI, old mock/real-image services, P03 preparation and capture roots are not switched to P04.

This lane uses Node 24 `node:sqlite`, Linux filesystem objects and a separate durable fake provider. The real integration is `integration.test.ts`: actual loopback HTTP → HMAC authentication → `SafeImageService` → `SqliteLedger`, with `ControlWorker` → `LocalFakeProvider` → `FileObjectStore` → fenced ledger publication. Independent `IndependentWatchdog` connections/processes recover and stop simulated resources. There are no passing stub services in that integration. Stub-based component tests remain useful but do not stand in for it.

- [Frozen local contracts](p04-contract.md): exact interfaces, accounting assumptions and protocol.
- [Provider decision proposal](p04-provider-decision.md): security, region, retention, durability, cost, integration, access, recovery, egress, signing and deletion; not an approved ADR.
- Source: `src/image-service/control-plane/`; private watchdog: `scripts/p04-watchdog.ts`; verification: `scripts/p04-verify.ts`.

## Boundaries and API

The HTTP helper returns an **unlistened** server. Trusted tests explicitly listen on `127.0.0.1` with an ephemeral port; no Vite/default frontend route is added. Direct loopback/host/origin checks, strict media/framing/UTF-8, 16 KiB actual input limit, request deadlines and bounded active slots apply. No worker, kill, stream, issuer, policy, callback, arbitrary command or paid-provider HTTP route exists.

`POST /__fury-control/v1/images` accepts only `{ protocol, design, idempotencyKey }`. `design` must be the strict existing v4 DesignEnvelope, including its named presentation and sole server-allowlisted `outputProfile` (`web-hero` or `web-thumbnail`). Unknown top-level/nested fields, v3 bodies, arbitrary cameras, samples, meshes, assets/URLs, scripts, callbacks, priorities and auth-in-body are rejected. Authentication is a verified expiring out-of-body bearer context; local HMAC issuance is trusted private code, not an HTTP endpoint or production identity provider.

- Exact verified cache hit: **200**, same immutable descriptor and checksum.
- Miss/coalesced pending work: **202**, durable job/interest identifiers and status path.
- Strict request validation: **422**; framing/media/oversize: 400/415/413.
- Missing/insufficient authentication: **401/403**; foreign interest: **404**.
- Capacity or synthetic reservation ceiling: **429**, no partial reservation.
- Kill/store outage/uncertain or unavailable work: **503**, never invented readiness.
- Ended idempotent interest or permanently retired immutable revision: **410**; key rebound to another request: **409**.

`GET /__fury-control/v1/interests/:id` and `/artifact` require owned principal+experiment interest. `POST .../:id/cancel` cancels **only that interest**, not shared execution or its liabilities. Durable job state and interest state are separate.

`POST /__fury-control/v1/exports` additionally requires `exports:write` and `format: diagnostic-svg`. It freezes the exact revision and isolates cache/object keys by principal and experiment. Delivery is an authenticated attachment, `private, no-store`, not a PDF, current design image or strict export. Export identity may match another principal's design revision; private object/cache identity never does.

**Signed export URL gap:** the component assignment requested principal+expiry+exact-identity signed URLs, while the frozen local contract expressly excludes signed URLs and has no signer/key interface. That conflict was reported, not silently resolved. Current authenticated delivery rejects token/query URLs; local auth tokens expire, but are **not** artifact-specific signed URLs. Signed URL implementation, revocation, cache behavior and aggregate delivery-budget enforcement remain blocked pending reviewed contract/provider decisions. Do not claim that requirement passed.

## Durable accounting, execution and publication

1. Admission independently reparses canonical identity inside `BEGIN IMMEDIATE`, coalesces public image misses, binds idempotency and atomically reserves the entire worst-case quote against global, experiment and principal accounts. Events capture requested/reserved/queued in the same transaction.
2. The first public miss sponsors the reservation. Other principals' coalesced interests consume that job's bounded pre-reserved delivery allowance; they do not reserve another renderer. Exports are principal+experiment isolated. This is the frozen accounting model, not a claim that public diagnostic identity permits public customer-data delivery.
3. Quotes use integer **synthetic microcurrency**, not real provider rates. Startup, runtime, idle, all prepaid retries, delivery, storage lifetime, shutdown and delayed-meter margin are included. Persistent concurrency, unique-miss, attempts, output, storage, delivery, interest, job and account bounds cannot be reset or raised via API.
4. A claim establishes execution-specific fence, attempt, lease, deadline and signed bounded worker context. Heartbeats and publication use the current fence; stale workers cannot ready a job. Unknown execution occupies liability/concurrency until reconciliation, including across process exit and restart.
5. Provider completion alone is insufficient. Worker validates labelled deterministic diagnostic content, records signed execution-bound meter, stages bounded bytes, begins publishing, publishes immutable filesystem bytes plus authenticated metadata, verifies readback/checksum and submits a signed object-verification receipt to the ledger's fenced ready transaction. Publication failure leaves failed/publishing evidence or an orphan, never ready.
6. Kill persists before stop attempts. Queued demonstrably unstarted work can cancel; active/unknown work retains reconciliation and liabilities. `stop-requested`, `stopped` and final billing are different facts. A late old start is rejected by durable fake-provider tombstones. No receipt means no refund. Runtime/cost breaches persist kill and unresolved liability.
7. The watchdog works with dispatcher absent. It inspects resources, stops provider-only orphans, closes durable simulated stream leases, reconciles only authenticated final evidence and runs safe retention. Reports with errors/nonzero CLI status are incomplete; `killed:false` during ledger outage is **not proof** kill is disabled. Orphan costs are never booked/refunded against an unrelated ledger job.

### Retention integration repair and limitations

The component watchdog originally recovered stages but did not call retention/deletion methods. Integration connected `retentionCandidates()` → `objects.delete()` → `confirmObjectDeleted()` and added actual filesystem deletion/failure/retry HTTP regressions. Failure retains descriptor and lifetime allocation, returns a sanitized error and never claims deletion. Unknown final objects remain quarantined/reported; no speculative orphan deletion or refund occurs.

The frozen deletion interface lacks an explicit deletion epoch/lease spanning filesystem and ledger. The concrete ledger therefore **permanently tombstones retired immutable keys**, excludes all live/shared/uncertain references before deletion, and denies future admission of that retired revision with 410. The watchdog depends on that concrete safety guarantee. Repeated/stale deletions cannot remove a newly published same-key object because republishing is permanently denied. This conservative availability hold is not production retention/republication design approval. Do not clear tombstones; a future fenced deletion contract requires review.

Publication removes stage payload but keeps authenticated stage metadata for replay until safe recovery. Lifetime payload-byte allocation is not replenished after deletion. Individual payload/metadata/inventory sizes are bounded, but the quoted payload allowance does not account for filesystem blocks/inodes/metadata or a remote object's backup/version/CDN footprint. External physical quotas and erasure receipts remain held.

## Verification and reproducibility

Only existing dependencies are used. No installation, browser/UI run, real rendering (including CPU Cycles), provider SDK/API execution, cloud mutation, deployment or git mutation is part of these commands.

```sh
export PATH=/home/ubuntu/.nvm/versions/node/v24.22.0/bin:$PATH
/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node scripts/p04-verify.ts focused
/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node scripts/p04-verify.ts checks
/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node scripts/p04-verify.ts full
/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node scripts/p04-verify.ts audit
```

Each command exclusively creates `fury-p04-handoff/integration-<mode>-<unique>/`. `checks.json` retains exact argument arrays, exit status, duration and log paths. Test runs save `vitest.json` and exact logs. Test/build children receive an explicit environment allowlist without inherited session/cloud credentials; temporary directories, Vite caches and build output stay in handoff. No DB/auth/context keys are written into evidence. Disposable test databases are removed by their owning tests, never existing operator stores.

Vitest is configured in memory (`config:false`, `cache:false`, `maxWorkers:1`) without DEV service/render plugins or source watchers. Full-suite tests reuse only the real app `fury-baked-stills` config/resolve/load hooks for the existing virtual manifest imports, instantiated with `command:build` and `VITEST:true`; they are not stubbed. The production build uses the actual Vite config but no `.env` file or shared temporary config cache, writes only to a unique handoff directory, and rejects any control-plane module in a public output chunk. Node/static/in-memory bundle checks do not execute the frontend or a renderer. Full tests include existing CPU geometry/preparation and mocked browser-pipe tests, not real browser or capture execution; no P03 receipts are rebuilt.

The watchdog component test starts a real dispatcher child that exits abruptly without shutdown, then independent CLI kill, reconciliation and repeated processes. First report is nonzero with stop requested and nonfinal meter; a later process confirms stopped plus final synthetic meter. It also checks that private generated keys do not appear in captured output. Public streams remain disabled: tested streams are durable local lease rows, **not actual remote/socket streams**.

Initial integration runs deliberately retain their logs: two failures found an incorrect expected HTTP status and missing retention wiring; the initial verification harness also found two readonly-fixture TypeScript errors and a build-command bracket typo, all repaired. The first full run passed all 1,797 collected tests but failed collection of six legacy suites because the isolated config lacked `virtual:fury-stills`; the real manifest resolver was then retained without DEV service hooks for the rerun. Formatting is applied only to P04 additions and the explicitly changed README, not retained source. Earlier component reports with historical failures are not the final result.

Final counts and exact evidence directories are recorded in `fury-p04-handoff/integration-exit.json` after verification. Treat that record, not this narrative, as the final run status.

## Exit checklist

### Review repairs

The independent reviewer reproduced three gaps; its original evidence is retained in `p04-independent-review.md`. The parent implementation then replaced all four unsafe characterization assertions with safe regressions:

- Finality contradictions now persist an execution-specific quarantine and audit event, kill admission, pin retained evidence and expose unknown outstanding liability without rewriting settled receipts/accounts. Historical running inventory is stopped rather than skipped by ID.
- Provider inventory/receipt/stop calls have deadlines and bounded retained operation slots. A hung stop cannot starve later stops or local stream closure. A separate-process fault test proves progress and persistence; it does not prove real-provider termination.
- Stage cleanup captures its age cutoff before its reference snapshot, protecting newly live stages under the explicit shared nondecreasing local-clock assumption. Distributed deletion/clock rollback remain held.

Parent repair verification is separate from the original independent verdict; no second independent approval is claimed. The handoff's `final-verification.json` supersedes earlier run counts. Production/provider gates remain; the later local legacy-retirement addendum below supersedes the historical source-level bypass finding.

“Passed locally” means the specified fake-only/CPU implementation and tests, not production qualification.

| Criterion                                                                        | Exit status                                                             | Evidence / remaining boundary                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Strict v4/named presentation/profile; unknown fields rejected; out-of-body auth  | Passed locally                                                          | Contracts, auth/API and actual loopback integration tests                         |
| Exact hit 200 / miss 202 / invalid 422 / quota 429 / outage/kill 503             | Passed locally                                                          | Real SQLite/object-store HTTP integration; ended revisions correctly 410          |
| Explicit private immutable diagnostic exports; no strict/PDF/current-image claim | Passed locally                                                          | Cross-principal/experiment 404, attachment/no-store, immutable revision tests     |
| Artifact-specific signed export URLs                                             | **Blocked**                                                             | Frozen interface conflict; no implementation, no claim                            |
| Requested/reserved/queued atomic events; all durable states; uncertainty flag    | Passed locally                                                          | Ledger lifecycle, restart and integration tests                                   |
| Atomic three-account worst-case reservations and all local caps                  | Passed locally                                                          | Actual concurrent independent SQLite processes, quota/rollback/cap tests          |
| Duplicate coalescing/idempotency, heartbeat/fencing, stale worker denial         | Passed locally                                                          | Ledger/worker/integration tests                                                   |
| Checksum-before-ready, immutable keys, failure never ready                       | Passed locally                                                          | Filesystem publish/readback plus real HTTP checksum verification                  |
| Persistent kill: queued, active, retries, delayed termination/meter, late start  | Passed locally                                                          | Worker/watchdog/provider/integration tests, independent child CLI                 |
| Orphan hosts, unknown outcomes and store/provider outage                         | Passed locally for simulated resources                                  | No guessed shutdown/cancellation/refund; errors retain uncertainty                |
| Stream kill                                                                      | Passed for durable fake leases only                                     | **Remote/socket/provider streams blocked**; no public stream API                  |
| Retention and failure/retry deletion                                             | Passed locally with availability hold                                   | Permanent retired-key tombstones, no lifetime-allocation reset                    |
| Real DB power-loss/backup restore/multi-host durability                          | **Blocked**                                                             | FULL synchronous/WAL tests are not power-loss certification                       |
| External object/CDN publication, erasure, delivery billing and quotas            | **Blocked**                                                             | Private local boundary only; no CDN or signed URL deployment                      |
| Provider selection/account access/region/retention/budget authorization          | **Blocked**                                                             | Proposed comparison; no resources provisioned or approved                         |
| Private server modules absent from frontend; production paid execution denied    | Passed for P04 boundary                                                 | Static import closure and actual production-build chunk audit                     |
| Existing legacy cloud spend paths obey P04                                       | **Local entry points retired; live deployment inventory still blocked** | Separate pre-existing paths below; never automatically qualified                  |
| Default v3/B UI and P03 source preserved                                         | Passed by source-manifest audit for retained files except README        | No UI run; full original capture/handoff byte audit remains parent responsibility |
| Full Vitest/typecheck/lint/format/build                                          | See final JSON/logs                                                     | Exact counts, status and run directories retained; no fabricated pass             |
| Rights/fonts/conversion/reference renderer/art approval                          | **Blocked / unchanged**                                                 | Prior P03 holds remain in force                                                   |

## Legacy-path audit — historical findings and later local retirement

**Later local addendum:** [legacy entry-point retirement](p04-legacy-retirement.md) disables production cloud selection, remote client/warm calls, raw-scene gateway dispatch, Modal deployment, raw-scene CLI startup and legacy baking. No provider was contacted or deployed. The findings below describe the preserved pre-retirement P04 baseline, not current callable entry points; old line numbers are historical. Existing live endpoints remain uninspected and must be inventoried before paid/public cutover.

These original findings are from **source inspection only**. No endpoint was contacted, deployment state inferred, secret inspected, Python renderer imported or execution performed. These are pre-existing paths, deliberately preserved rather than silently widened into this approval.

1. `src/render/traceStatus.ts:21-37`: loopback `?cloud=` override and optional build-time `VITE_CLOUD_RENDER_URL` select the old renderer independently of P04. `src/render/renderSession.ts:26-50` creates an unauthenticated local-storage session identifier, not a principal grant; `:66-76` calls `/warm` directly.
2. `src/render/cloud.ts:734` uploads blobs; `:813` builds a scene/camera request; `:862` posts `/render?session=...`. These are client scene/mesh/blob/camera traffic and browser-selected work, not strict server v4 DesignEnvelope admission through P04.
3. `render-server/fury_render/gateway.py:1-10,129-169,184-218,220-304`: old origin/CORS configuration, process-memory token buckets/session places, `/warm`, blob and render dispatch. CORS is not authenticated principal authorization or durable global/experiment/principal reservation. Gateway restart/idle assumptions are not receipt-based liability reconciliation. The old bake token lifts render time limits; it is not P04 admission.
4. `render-server/modal_app.py:26-37,75-90,124-140,150-201`: independent Modal GPU/session classes, idle tails, optional always-warm renderer, volume and remote dispatch. These are actual paid-capable source paths with no P04 ledger/kill integration. P04's immutable `paidExecutionAllowed:false` does **not** disable them.
5. Existing Vite local-render/prototype plugins are separate legacy DEV paths (`vite.config.ts:140-154`), not P04 mounting or cost qualification. No default/UI or real-image adapter was edited to imply cutover.

Before any paid or public rollout, the owner must explicitly disable/isolate or replace every legacy dispatch/warm/upload/bake/export route and verify deployment configuration, authentication, reservation, watchdog authority and provider evidence across the actual boundary. This requires a separately reviewed cutover plan. Documentation of the bypass is not remediation, permission to operate it or a claim of an active deployment vulnerability.

## Decisions still required

- Resolve signed-export-URL scope versus frozen authenticated-only contract; decide principal binding, expiry, revocation, no-store/cache semantics and delivery budget authority.
- Approve provider stack, accounts/access, jurisdiction/region, DPA/retention/compliance, egress paths, real rates, funded ceilings and deletion/backup/CDN guarantees. Supabase/Vercel/Modal are options, not approvals; the provider proposal favors portable PostgreSQL + private immutable storage and conditionally private workers.
- Provision independent operator/watchdog scheduling, authenticated identity/grants/revocation, key custody/rotation, secret separation, monitoring and restore drills. Local HMAC issuance is not that infrastructure.
- Keep ledger DB with its `.p04-identity` companion and provider DB with its `.p04-provider-identity` companion. Missing primary DB fails closed; loss of the whole namespace cannot be distinguished from first creation without an external provisioning registry. Never recreate stores to clear limits.
- Decide whether to accept permanent-retirement availability loss locally or design a reviewed deletion epoch/lease contract. Do not silently prune tombstones, events or budget history.
- Qualify actual provider stop/meter finality, startup/idle/shutdown costs, late billing, physical storage/inodes, external stream shutdown and orphan recovery. Local signatures/synthetic receipts prove none of those external facts.
- Retain all P03 rights/font/conversion/strict-reference and renderer/art approval holds. No new real image, strict export or production readiness is claimed.
