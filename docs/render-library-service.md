# Durable render-library service

This implements the server half of `fury.render-library@1`. A browser lookup is read-only.
Only a same-origin, CSRF-protected explicit **Bring your vision to life** request can reserve
missing images. Supabase Postgres is the authority, not a Vercel process or an in-memory map.
The service never launches a GPU itself: a separately running, private CPU dispatcher drains
the durable outbox and creates bounded native GPU Sandboxes. Deploying this code does not
register a recipe, enable rendering, approve spend, run migrations or start the dispatcher.

## Integration and packaging

The integration includes the following shared-package/config changes:

1. **`sharp: "0.35.5"`** is a locked production dependency. Include its
   Linux native/optional dependencies in the Vercel installation; it is not a browser dependency.
2. `api` is included in `tsconfig.json`'s checked sources. Server tests also import all handlers.
3. Existing static asset headers in `vercel.json` are preserved alongside:

   ```json
   {
     "functions": {
       "api/**/*.ts": {
         "includeFiles": "public/native-library/manifest.json",
         "maxDuration": 60,
         "memory": 1024
       }
     }
   }
   ```

   Check function memory support for the chosen Vercel plan/runtime. Use Node, not Edge.
   Do **not** bundle 400 WebPs into each function. Seed images remain static public assets;
   the server reads the pinned manifest and fetches exact digest paths from its configured
   HTTPS public origin, then verifies/decompresses the actual bytes. Importing those verified
   descriptors into Postgres avoids repeating the network/decode work on normal cache hits.

4. These are explicit filesystem Node functions, not an assumed wildcard router. Named
   Web Standard `GET`/`POST` exports follow the official
   [Node runtime documentation](https://vercel.com/docs/functions/runtimes/node-js).
   Keep API paths ahead of any new SPA fallback rewrite; do not rewrite `/api/*` to HTML.
5. Deploy preview API packaging and inspect all routes before activation. `vite dev` alone
   serves no Vercel functions. No Vercel deployment/routing assertion is established by Vitest.

| Method | URL                                     | Entrypoint                                 |
| ------ | --------------------------------------- | ------------------------------------------ |
| POST   | `/api/render-library/lookup`            | `api/render-library/lookup.ts`             |
| GET    | `/api/render-library/session`           | `api/render-library/session.ts`            |
| POST   | `/api/render-library/jobs`              | `api/render-library/jobs/index.ts`         |
| GET    | `/api/render-library/jobs/:jobId`       | `api/render-library/jobs/[jobId]/index.ts` |
| POST   | `/api/render-library/jobs/:jobId/retry` | `api/render-library/jobs/[jobId]/retry.ts` |
| POST   | `/api/render-library/worker/claim`      | `api/render-library/worker/claim.ts`       |
| POST   | `/api/render-library/worker/uploads`    | `api/render-library/worker/uploads.ts`     |
| POST   | `/api/render-library/worker/events`     | `api/render-library/worker/events.ts`      |

### Server-only environment

Never prefix any of these with `VITE_`, return them to a browser, commit their values, or log
request headers, service-role HTTP response bodies, signed upload URLs or provider errors.

| Variable                          | Required meaning                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `RENDER_LIBRARY_PUBLIC_ORIGIN`    | Exact HTTPS origin hosting API and static images, no path/query. Preview origins need their own configuration. |
| `RENDER_LIBRARY_SUPABASE_URL`     | Exact HTTPS Supabase API origin, no path/query.                                                                |
| `RENDER_LIBRARY_SERVICE_ROLE_KEY` | Privileged server/CPU-dispatcher credential; never sent to GPU Sandbox or browser.                             |
| `RENDER_LIBRARY_SESSION_SECRET`   | At least 32 random characters, separate from worker token. Rotation invalidates sessions.                      |
| `RENDER_LIBRARY_WORKER_TOKEN`     | At least 32 random characters, private dispatcher-to-service bearer token.                                     |
| `RENDER_LIBRARY_APPROVAL_ID`      | UUID of the explicitly authorized singleton budget ledger.                                                     |
| `RENDER_LIBRARY_ENABLED`          | Exactly `true` to permit admission and HTTP worker claims; omitted means disabled.                             |
| `RENDER_LIBRARY_DISPATCH_MODE`    | Exactly `private-poller`; no unsupported dispatcher silently falls back.                                       |

Session bootstrap creates a signed `__Host-` HttpOnly/Secure/SameSite=Strict cookie valid for
24 hours and a session-bound 15-minute CSRF token. Every mutation verifies exact Origin and
Fetch Metadata where supplied. No CORS headers are emitted. Polling requires a valid session
that created or explicitly joined that job. A different visitor can keep making read-only
lookup requests to follow the same shared set; never auto-create merely to gain membership.

Network attribution is deliberately conservative: all anonymous traffic shares one HMAC
network quota. Untrusted `X-Forwarded-For` cannot reset it. Limits are 3 admitted jobs/session/hour,
6/network/hour and 12 globally/hour. Admission reserves full financial liability, not an idle
GPU: additional distinct designs queue durably even when both execution slots are occupied.
Dispatch is limited to one unsettled claimed job per lane and two globally, including uncertain
provider starts. Both slots may belong to the same session. Joins/cache hits
do not spend or count as new jobs. Configure platform rate limits for lookup/session endpoints
before exposing the service broadly; these SQL admission quotas bound GPU spend, not arbitrary
read traffic or session-row growth. Replacing shared network attribution requires a verified
platform IP source, not a request header accepted on faith.

## Database and Storage installation (operator approval required)

Apply migrations in order to a chosen Supabase project only after review:

- `202610190001_render_library.sql`: durable ledger, mutation RPCs, immutable identity/asset
  triggers, RLS and privilege revocation. Every mutation RPC serializes on one advisory lock;
  no external I/O is performed inside that transaction.
- `202610190002_render_library_storage.sql`: public `render-library` and private
  `render-library-staging`, WebP-only, 8 MiB maximum. Existing buckets with incompatible
  settings cause migration failure rather than silently weakening access.
- `202610190003_render_library_recovery.sql`: fenced uncertain-to-accepted dispatch
  resolution and service-only reads of the actual per-job reservation. Apply before
  starting the updated dispatcher; do not derive settlement from current policy limits.
- `202610200006_shared_interior_views.sql`: interior-visible view keying. The `entry-draft@1`
  image key hashes only interior-visible choices (`viewDesign` drops add-ons, railing, finish
  and accent), so exterior-only variants share one interior image. Snapshots and readiness
  look images up by `image_key` across sets; the object stays under the publishing set's
  path. Pause the render queue and drain in-flight jobs, then apply this migration, deploy the
  API and register the matching worker build together before resuming.
- `202610190004_hosted_dispatcher.sql` and `202610190005_dispatcher_headroom.sql`:
  shared CPU/GPU budget accounting and recovery headroom.
- `202610200001_render_queue_lanes.sql`: durable queue admission, latest-request priority,
  independent foreground/background dispatch slots, and a fenced shared-app shutdown.
  **Do not apply to the existing hosted worker without the compatibility rollout below.**
- `202610200002_worker_builds.sql`: append-only execution registrations and an active-build
  pointer separate from the unchanged customer policy/image recipe. Historical jobs and
  receipts retain their own registrations. Legacy builds keep the one-job session ceiling;
  the approved queue build permits two. Apply together with the queue migration, following
  the compatible queue-worker rollout in `render-server/on_demand/README.md`.

`anon`, `authenticated` and `PUBLIC` have no table or RPC privileges on the ledger.
`service_role` gets table DML and RPC execution; this credential is an administrative trust
boundary. Restrictive Storage policies forbid browser insert/update/delete in either bucket
even if an older permissive project-wide policy exists, and forbid authenticated/anonymous
staging reads. Public final-image downloads are intentional. A Supabase service-role holder
can bypass Storage RLS: administrative credentials and bucket retention remain operational
trust boundaries, not claimed WORM guarantees against project administrators.

The application writes final images **only** with `x-upsert:false` to
`set_<sha>/img_<sha>/<content-sha>.webp`. A failed duplicate write is followed by a bounded
independent read and checksum/length comparison; never overwrite. Do not attach lifecycle
deletion to the final bucket. Private staging keys are
`jobId/attemptId/imageKey/content-sha.webp`. Signed uploads authorize only that path without
overwrite. Supabase's signed-upload endpoint has a fixed two-hour token lifetime; it does not
honor arbitrary short `expiresIn`. The receipt-specific `maxBytes` is a worker instruction;
the bucket enforces 8 MiB and publication enforces the exact receipt byte count. An expired
job cannot publish a new image merely because its upload URL is still valid. Clean staging
objects later than token lifetime/job completion; never delete final immutable objects.

### Recipe, seed import, and spend activation

1. Register a reviewed recipe release only with independently established worker, recipe bundle,
   geometry, materials, cameras and renderer SHA-256 values. `registrationSchema` specifies
   the exact JSON. Registration cannot be updated/deleted: changed source requires a newly
   versioned contract/release, not changing what an existing key means. There are no placeholder
   hashes or auto-registration in the migration.
2. Optionally call `importSeedLibrary` from `src/render-library/server/importSeed.ts` using a
   trusted TypeScript operator runner, with `RENDER_LIBRARY_ALLOW_SEED_IMPORT=import-pinned-400`
   and the three origin/credential settings above. The function is importable, has no top-level
   effects, returns only counts and does not print credentials. It verifies the pinned manifest,
   fetches and fully decodes every matched WebP, and invokes the service-role-only
   `render_library_import_seed(design,identity,images)` RPC. Repeating an exact import is safe;
   conflicting descriptors fail. No jobs, outbox, approval or liability are created. The
   400 historical descriptors keep `seed-cache` provenance and static digest URLs; they are
   not relabeled as native-worker output. Unimported seeds still work via verified static
   fallback (cold reads are slower). Native-only misses require a healthy authoritative DB.
3. After explicit spend authorization, insert one approval UUID, disabled initially, with an
   expiry, positive integer micro-USD budget, zero reserved/charged balances and exact policy
   JSON matching `policySchema`. Its `recipe` must equal the immutable registration. Estimate
   worst-case startup liability plus missing-image liability at the actual bounded L40S price,
   including startup/preparation/timeout exposure, not average observed cost. No default price,
   historical credit or experiment reconciliation is supplied. `maxJobLiabilityMicroUsd` must
   bound startup plus all five images; missing-only retries reserve fewer images.
4. Deploy/configure/run the private dispatcher, verify its build/recipe and approved GPU bounds,
   and verify the production origin plus secret isolation. Enable both the approval row and
   `RENDER_LIBRARY_ENABLED=true` only after these checks. Configuration alone cannot prove a
   running dispatcher; monitor pending-outbox age and absence of drain activity.
5. To stop new work, disable the approval row and service flag. Never clear unsettled liability.
   Existing callbacks remain verifiable so completed images are not discarded. Reconcile
   every outstanding provider before increasing concurrency or allowing missing-view retries.

## Continuous dispatcher and recovery contract

The dispatcher is a private, continuously running CPU **process**, not a publicly callable
renderer or retryable Modal CPU Function. Deployment supervisors may restart the process;
restarts never imply resubmitting a claimed dispatch. No manual operator action is needed per
customer click while the dispatcher is healthy.

1. Poll `render_library_claim_dispatch({dispatcherId,lane})` with the service-role credential.
   `lane` is `foreground` (the default for old callers) or `background`. The foreground lane
   selects each session's latest explicitly requested job. The background lane drains all
   pending work oldest-first, including pre-migration jobs with no foreground pointer. A join
   with a fresh idempotency key promotes a queued design without another reservation; replaying
   an old key does not reorder work. Latest-request priority does not expire during a long render.
   Browser edits/disconnects do not revoke a request, reservation or provider slot.
   A non-null `{dispatch,claimToken}` marks the outbox dispatching and job dispatch-uncertain
   **before** external work. Null means no eligible work or that lane's slot is occupied. Back off idle
   polling. Claim loss is deliberately not reclaimed by a TTL.
2. Call authenticated HTTP `worker/claim` with `{...dispatch,workerBuildSha256}` exactly once.
   `{claim:null}` must never produce GPU work. It checks current activation, registration,
   reservation and one-shot worker ownership. Persist/retain that claim before preparation.
3. Perform trusted CPU scene preparation, then create one GPU Sandbox named by the dispatch
   UUID. No arbitrary browser code/path/scene is accepted. Native worker recipe constraints
   are unchanged: L40S, Cycles/OptiX, 1024 nonadaptive samples, quality 95, five fixed cameras,
   exact wide/tall sizes, no CPU rendering fallback, no provider retry.
4. `render_library_record_dispatch({dispatchId,claimToken,result})` stores accepted with
   opaque `providerCallId` (the Modal `sb-...` Sandbox ID), uncertain, or definitely-not-submitted.
   A timeout/lost response after the possible spawn boundary is **uncertain**, never proof
   of failure. Do not retry Sandbox creation, even if a provider's name lookup is temporarily
   empty. The token fences acknowledgements and permits only `uncertain` → `accepted`
   resolution to a discovered provider. Accepted IDs cannot change or be downgraded;
   identical replays remain idempotent. No provider IDs are exposed publicly.
5. Stream monotonic `sequence` events with stable UUID event IDs per attempt. Before upload,
   call `worker/uploads` with the **same complete artifact event** later sent to `worker/events`.
   The server verifies claim/recipe/design/camera/sample metadata and records a private
   artifact intent; upload WebP to its exact signed staging path with no overwrite. The event
   endpoint independently fetches staging bytes, checks SHA/length/WebP signature, inspects
   dimensions/frame count, and fully decodes every pixel using Sharp before final publication.
   Final DB descriptor publication and artifact event acceptance are a single transaction.
   Conflicting IDs/receipts, stale fences and old sequences cannot mark a new image ready.
6. A terminal renderer event changes customer-visible state only. It **never** releases budget
   or makes retry safe. The independent dispatcher/reconciler polls the actual provider ID;
   only a non-null provider terminal result plus retained hashed provider evidence supports
   `render_library_reconcile_terminal({jobId,evidence,chargedMicroUsd})`. For uncertain creates,
   independently identify the dispatch-named Sandbox first. Hash the retained evidence, not
   an invented acknowledgement. This reconciliation RPC is never exposed as worker HTTP.
7. If provider charges are not known, conservatively settle the whole reserved worst-case
   amount read from `render_library_dispatch_reservation({dispatchId,claimToken})`, not
   a policy ceiling or a local journal's historical estimate. That read is service-only
   and fenced; failure retains liability. A definitely-not-submitted result can be reconciled
   with `never-submitted` evidence and zero charge only when no spawn was possible. The
   service cannot independently call Modal; the separately privileged reconciler is trusted
   to establish provider evidence and enforce these rules.
   Provider polling and termination precede artifact replay. Replay failures cannot block
   terminal settlement; exact published events can be acknowledged even after expiry without
   uploading again. New publication still rejects expired/settled claims, and settled jobs
   replay acknowledgements only. Saved images remain immutable through failures and retries.
8. After verified settlement, an explicit retry reserves only missing images and supersedes
   the prior failed job. Completed images remain immutable/reusable. Stable retry idempotency
   keys replay the same job. Old attempts cannot overwrite new ownership. Unknown providers
   hold liability and block unsafe retries indefinitely; an incident needs reconciliation,
   not a deadline-based refund or automatic redispatch.

Operational drain: first stop claiming new pending rows, allow active Sandboxes to terminate,
publish verified partials, independently reconcile, then stop the process. On restart, drain
new pending rows and investigate dispatching/uncertain/accepted rows without resubmission.
Deadlines bound worker execution but are not proof that a provider is terminal.

## Local verification (no remote DB, provider, GPU or browser)

### Preview deployment gate

Vercel builds require `RENDER_LIBRARY_SUPABASE_URL`, `RENDER_LIBRARY_SERVICE_ROLE_KEY`
and `VITE_RENDER_LIBRARY_STORAGE_ORIGIN`. The two storage origins must match exactly and
be HTTPS origins without a trailing slash. `npm run build` fails before compilation if
these are missing or inconsistent; local offline builds remain available.

Preview variables are branch-scoped: merging code does **not** copy configuration.
Provision the exact target branch and redeploy. Keep the service-role key server-only;
never use a `VITE_` prefix for credentials or grant all preview branches blanket access.
A lookup-only preview needs these three variables, not rendering approval/worker credentials.
Verify a known saved design through `/api/render-library/lookup` and browser descriptor
verification before sharing the preview. Lookup failure is not evidence of a cache miss.

The API, frontend and database must share the current `interior-visible@1` identity contract.
Saved descriptors retain their original publishing `setKey`; image identity, recipe, design
and storage-object binding—not equality with the requested set key—prove reuse is valid.

Install the integrator's locked dependencies, including Sharp. Unit checks:

```sh
npm run typecheck
npm run lint
npm run format:check
npx vitest run src/render-library/server/tests/server.test.ts
```

### Pause bulk work without blocking customers

Operators can park a campaign by inserting its session hashes into
`render_library_queue_pauses` using the service role. Do not disable the global approval:
that would also reject customer render requests. Serialize pause/resume operations with
`pg_advisory_xact_lock(73941020261019)` in the same transaction as the insert/delete.

Both dispatch lanes skip parked sessions while continuing to serve other customers.
Already-running jobs finish normally. Queued designs, pending outbox entries and budget
reservations remain intact. An explicit request from an unpaused customer can reuse a
parked job; its idempotency record keeps that request runnable even after the customer
switches to another configuration. To resume a campaign, delete only its own pause rows.
The table is RLS-protected and unavailable to anonymous/authenticated client roles.

### Real transaction tests

Real transaction tests require Docker and use **only** a named container plus the fixed
throwaway database `fury_library_test`; they never read `DATABASE_URL`. They drop/recreate
that database's `public` and synthetic `storage` schemas. Never point this suite at a container
holding valuable data. Reproducible setup from a fresh machine:

```sh
docker run -d --name fury-library-postgres \
  -e POSTGRES_PASSWORD=local-test-only -p 127.0.0.1:55432:5432 postgres:16-alpine
# Wait until pg_isready succeeds before proceeding.
docker exec fury-library-postgres pg_isready -U postgres
docker exec fury-library-postgres psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;'
docker exec fury-library-postgres psql -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE fury_library_test;'
RENDER_LIBRARY_TEST_CONTAINER=fury-library-postgres \
  npx vitest run src/render-library/server/tests/postgres.test.ts
```

Omit the opt-in variable and those SQL tests are explicitly skipped, not falsely passed.
The suite uses real PostgreSQL transactions and independent concurrent `psql` connections.
It covers duplicate admission, budget races, session/network/global capacity, exact idempotency,
activation/expiry, one-shot claims, uncertain dispatch, out-of-order/conflicting callbacks,
partial publication/retry, immutable seed import, anon/authenticated privilege denial,
service-role RPC grants and restrictive Storage policies against a permissive baseline.
HTTP tests use explicit Supabase/provider doubles. Decoder tests generate actual WebP bytes,
decode them and reject truncated payloads, bad dimensions, lengths and hashes.

### Remaining verification boundaries

- Storage policy SQL runs locally against a minimal schema; signed URL uploads, deployed
  Storage HTTP semantics, Vercel filesystem routing/native packaging, and private dispatcher
  startup/drain require a separately approved staging run. This work performed none of them.
- No paid GPU, Modal deployment/app creation, live Supabase mutation or production cutover.
- Admission policy price adequacy and real worker source registration require operator review.
- Additional internal schema is intentional: `artifact_intents` binds pre-upload event bodies;
  `render_library_prepare_artifact` and `render_library_import_seed` are service-role-only RPCs.
  Idempotency `job_id` is nullable **only** for cache-only responses, which must not invent a job.
  All other prepared public request/response shapes and stable RPC argument names remain intact.
