# Local mock image service — provisional v4

This is a local, unpublished CPU diagnostic prototype for the image-first configurator described in original-plan sections 8, 9 and 12. It is not a floor-plan-only replacement, a production renderer, P01–P04/G1 completion, a current-design image, an engineering approval or permission to spend. The arrangements, proposed environments, eight Day/Night looks and seven cameras remain drafts. Production and paid execution are unconditionally denied by the domain and wire protocol.

## Integration and operator startup

The integration pass wires `prototypeImagePlugin()` into the existing Vite plugin list without removing existing plugins or replacing default v3 behavior. `vite.config.ts` lazily imports it only for command `serve`, not preview, nonproduction mode/NODE_ENV, and exact `FURY_IMAGE_PROTOTYPE=1`. Neither default v3 development nor any production build loads the service through this config path.

The plugin is `apply: 'serve'`, disabled unless `FURY_IMAGE_PROTOTYPE=1`, and additionally refuses production configuration, `NODE_ENV=production`, and build commands. It does not mount in preview/build or start its own server. SQLite is loaded lazily only inside the enabled path, including when Vite bundles its config. A missing SQLite runtime or denied store yields a local-only typed unavailable response, never an in-memory/unreserved fallback.

The separately approved browser pass verified this isolated local startup with Node 24. The isolated HOME already existed outside the checkout; preserve it across restarts rather than resetting its ledger:

```sh
FURY_IMAGE_PROTOTYPE=1 \
HOME=/home/ubuntu/Documents/fury-image-test/service-home \
PATH=/home/ubuntu/.nvm/versions/node/v24.22.0/bin:$PATH \
npm run dev -- --host 127.0.0.1 --port 5193 --strictPort
```

Use the existing DEV-only `/?prototype=images` application path, not the standalone review page. Keep browser imports confined to `src/image-service/protocol.ts`; the store/service/plugin are Node-only. Keep polling bounded, detach obsolete interests, capture each submitted revision, validate replies using the protocol's asynchronous parsers, decode before display, then check the latest selection again. Preserve the diagnostic disclaimer permanently. This unpublished, task-specific recipe belongs here rather than in automatic environment startup; the existing dependency blueprint remains unchanged.

Default durable state is outside source:

```text
~/.local/state/fury-image-prototype/<first-16-hex-of-SHA256(real-project-root)>/
  mock-jobs.sqlite
  mock-jobs.sqlite-wal / mock-jobs.sqlite-shm  (SQLite-managed, when present)
  STOP                                       (operator-created kill signal)
```

A trusted `prototypeImagePlugin({ stateDirectory: '/absolute/local/path' })` override must remain outside the project root; symlink aliases into source are rejected before directory creation. Runtime directory mode is 0700; the database is 0600. Test state uses isolated temporary SQLite files and is cleaned by tests. No browser storage, legacy/review records, baked manifests or historical stills are read, migrated or overwritten here.

## Frozen HTTP contract

All routes are same-origin and below `/__fury-prototype/v1`:

| Operation                                                                     | Response                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /images`, `createImageRequest(design, idempotencyKey?)`                 | 202 queued/rendering, or 200 **ready mock diagnostic**, never an approved/cache-parity claim |
| `GET /image-jobs/:interestId`, no body                                        | 200 interest-scoped queued/rendering/ready/failed/expired/cancelled snapshot                 |
| `POST /image-jobs/:interestId/cancel`, `createImageCancelRequest(interestId)` | 200 cancelled, `cancellationScope: 'interest-only'`, `sharedWorkCancelled: false`            |

There is no public reset, budget adjustment, reconciliation, kill/un-kill, export, upload, provider, arbitrary asset fetch or worker-command route. No CORS headers are granted. Errors use the frozen typed `imageErrorReplySchema`: malformed JSON/UTF-8 400; byte cap 413; compressed/non-JSON 415; invalid/future/unknown/injected fields 422; conflicting idempotency 409; ended idempotent interest 410; capacity 429; unavailable reservation store 503; nonlocal/cross-origin 403; unknown owned interest 404. Unknown paths/versions are 404; invalid methods 405. Body timeout is 408 with `invalid-request`. All replies are private/no-store.

### Local request protection and its limits

- Require direct socket peer `127.0.0.1`, `::1` or its IPv4-mapped equivalent and exact Host `localhost`, `127.0.0.1` or `[::1]`, with an optional valid port. Reject forwarding headers, duplicate sensitive headers, cross-origin Origin and cross-site fetch metadata. POST requires the exact local Origin; GET may omit it. This intentionally rejects remote tunnels/proxies and LAN access even if Vite itself is broadly bound.
- A random local principal is issued on submission in a path-scoped HttpOnly, SameSite=Strict cookie; Secure is added on HTTPS. HMAC verification uses a durable random server-only secret in SQLite, so possession-based isolation survives a service restart. Status and detach always bind both principal and opaque interest ID. Principal values are never accepted from request JSON.
- This is **not production authentication**. Cookies are bearer capabilities; local HTTP is not encrypted; the browser's one-day Max-Age is not a server-validated token-expiry protocol. Same-machine processes can impersonate local HTTP clients, and a same-UID attacker can modify local files. Cookie rotation is cheap. Global lifetime capacity still limits this prototype, but signed expiring sessions, distributed abuse/IP controls, TLS, stronger staff authorization, privacy policy and audit are unresolved production work.
- The middleware retains at most 16 KiB of actual uncompressed UTF-8 request bytes, not merely a claimed Content-Length. JSON and UTF-8 must both be valid. The default body deadline is two seconds; at most 16 control requests are active per middleware instance. Unread rejected streams are paused and the response closes the connection rather than draining unlimited data. Node/Vite's transport/header limits are separate; this is not an internet-edge denial-of-service defense.

## Durability, reservations and publication

`MockJobStore` uses built-in Node SQLite, WAL, foreign keys, a 500 ms busy timeout and synchronous `BEGIN IMMEDIATE` transactions. Each new logical miss atomically writes a unique request-digest job, worst-case reservation and interest. The unique logical key coalesces duplicate requests across service instances. A principal+idempotency-key uniqueness constraint binds a key to its request digest and interest. The first admitting principal sponsors synthetic work; coalescers consume bounded interest slots but do not duplicate the job reservation. No principal ID enters a public artifact identity.

The admission policy is persisted and frozen. Reopening with changed policy or a future/unknown database schema is denied; there is no automatic migration or budget-reset operation. A job is queued only after reservation. Dispatch increments its attempt and fencing token, records a bounded lease, and counts rendering **and uncertain** jobs against global concurrency. The transactionally stored queue is the local durable work outbox; no external broker is claimed.

Default limits (trusted construction options may lower/change them only when initially creating a separate store):

| Bound                                                     | Default     |
| --------------------------------------------------------- | ----------- |
| Lifetime global synthetic work units                      | 200         |
| Lifetime admitting-principal synthetic work units         | 40          |
| Attempts per unique job, including retries                | 2           |
| Global rendering plus uncertain jobs                      | 2           |
| Retained unique jobs                                      | 128         |
| Retained interests / per principal                        | 512 / 32    |
| Retained principal balance accounts                       | 128         |
| Lease / original job deadline                             | 10 s / 60 s |
| Interest lifetime                                         | 5 min       |
| Retry delay                                               | 250 ms      |
| Retention after interest expiry / terminal job completion | 24 h        |

Each unique miss reserves `maxAttempts` units up front; one actual fake attempt costs one unit, including known failures. Successful completion charges one and releases unused retry allowance. Known retryable failure charges one while retaining the allowance for the bounded retry. A queued deadline expiry releases its unstarted allowance. Retention never deletes a spent principal balance or resets global spend. Idempotency bindings last until interest retention deletion, not forever. Dead terminal keys deny new work until eligible cleanup rather than silently restarting attempts. Unknown executions are never automatically purged. These choices deliberately prefer fail-closed exhaustion over unlimited local resets. Detaching even the last interest does not certify job cancellation: already reserved work may finish or expire under its original limits. Browser disconnect likewise does not refund or cancel the job.

A heartbeat can extend a current fenced lease only up to the original job deadline. The normal diagnostic adapter is short-lived and needs no periodic heartbeat. Expired leases become **uncertain**, invalidate old fencing tokens, retain liabilities and occupy concurrency. Frozen v1 has no uncertainty state, so the interest receives `failed/unavailable` with explicit reconciliation text, not a false cancellation/success. A late completion cannot publish. The store may be inspected/reconciled later; it does not pretend that a vanished process proves stopped execution.

The sole `FakeRenderer` builds the protocol's deterministic labelled SVG. It contains no network client, provider SDK, shell engine, arbitrary asset URL or paid adapter. Unit tests can inject a clock, scripted known/unknown failure, wrong artifact or manually released delay. The service recomputes and validates identity, exact diagnostic bytes, checksum, dimensions and provenance **before** a fenced publication transaction. The verified inline artifact and ready state commit together; there is no object-store upload claim. Ready reads revalidate against the deterministic recipe too. Every artifact carries `exactMatch: false`, `approvedCurrentImage: false`, `cacheStatus: 'not-a-production-cache-result'` and the visible “MOCK DIAGNOSTIC — NOT A CURRENT DESIGN IMAGE” label. No historical bake is relabelled as new art.

SQLite page count is bounded at 8192 pages (approximately 32 MiB with default 4 KiB pages), with a 1 MiB journal size target and automatic WAL checkpointing. Row and input caps provide additional bounds. These settings are **not an OS filesystem quota**; an external long-lived SQLite reader can delay WAL truncation. There is no network-filesystem/multi-host guarantee, production migration system, encrypted storage or separate archival service.

## Kill, shutdown and reconciliation

The independent manual signal is a file named `STOP` in the state directory, or server-process environment `FURY_IMAGE_PROTOTYPE_STOP=1`. The dispatcher checks every 100 ms while the event loop is available and checks again on submission and before publication. Detection latches `killed=1` transactionally: future admissions/dispatch stop, queued work becomes failed and releases unstarted allowance, in-flight work becomes fenced uncertain and retains its reservation. Removing the file or restarting does **not** clear the persisted latch. There is intentionally no un-kill/reset endpoint or helper. Do not delete/replace the database to hide liabilities. Any new experiment namespace/budget requires an explicit local operator decision and preservation of the old receipt.

Process shutdown stops admission/dispatch and closes the store but does not claim that in-flight work was cancelled. Reopening resumes queued jobs; expired active leases require reconciliation. The operator-only TypeScript APIs are:

```ts
store.inspect(): MockLedger
store.uncertainAttempts(): { jobId: string; fence: number }[]
store.kill(): void
store.reconcileStoppedMock(jobId, fence, { confirmedStopped: true }): boolean
```

Use reconciliation only after verifying the old local fake execution has ended (the deterministic tests release and await it). It conservatively charges the uncertain attempt, retains any retry allowance, and queues a bounded retry only if not killed, under the original deadline and retry cap. Otherwise it terminates and releases unused allowance. It rejects stale reconciliation tokens. The assertion is not provider proof; there is no provider watchdog, host termination, dollar metering, exactly-once billing, or paid kill-switch enforcement. Unresolved outcomes must remain held. Local source/SQLite access is a trusted operator capability, not a public API.

## Exported implementation interfaces

- `prototypeImagePlugin(options?: PrototypeImagePluginOptions): Plugin` in `scripts/prototype-image-plugin.ts`.
- `createMockImageMiddleware(options: MockHttpOptions): MockImageMiddleware` and `unavailableMockImageMiddleware(): MockImageMiddleware` in `src/image-service/http.ts`. The middleware receives ordinary Node request/response objects and a `next` callback; it creates no listener.
- `new MockImageService({ store, renderer?, now?, stopRequested? })`: `submit(principal, input): Promise<ImageSubmissionReply>`, `status(principal, interestId): Promise<ImageReply>`, `detach(principal, interestId): Promise<cancelled reply>`, `runOnce(): Promise<number>`, `shutdown(): void`, `close(): void`.
- `new MockJobStore({ path, policy?, now? })`: transactional admission/read/detach, `claim(): MockLease | null`, `renew(lease): number | null`, `publishVerified(lease, artifact): boolean`, `fail(lease, error, outcome): boolean`, operator inspection/reconciliation/kill, `principalSecret(): string` (server-only), `close(): void`. Only the service should call `publishVerified`, after protocol integrity validation. The store is not a public trust boundary.
- `new FakeRenderer({ outcomes?, held? })`: `render(lease): Promise<MockArtifact>`, `releaseNext(): void`, diagnostic `calls`/`pending`. Outcomes are `success`, `known-failure`, `unknown-failure`, `wrong-artifact`. No real renderer interface is offered.

## Focused verification and remaining gates

Use Node 24 and existing dependencies only:

```sh
PATH=/home/ubuntu/.nvm/versions/node/v24.22.0/bin:$PATH npx vitest run src/image-service/service.test.ts src/image-service/http.test.ts scripts/prototype-image-plugin.test.ts
```

Tests use real temporary SQLite databases, separate store instances, injected clocks, fake gates, HTTP request streams and a mocked Vite hook object. These focused tests do not listen on a port, start Vite, drive a browser or call a real renderer/provider. Coverage includes duplicate coalescing, idempotency and ownership, restart, lease expiry and fencing, known/unknown failures, budgets/retention, shutdown/admission races, persistent kill, database locks/denial, malformed/future/injected fields, byte/time/request limits and artifact mismatch. The integration pass additionally adds `src/image-service/integration.test.ts`: disposable real loopback HTTP tests across all six stress fixtures and the actual client with a stub decode. Those tests do listen on ephemeral local ports, but start no Vite/browser server and make no external request. Domain/protocol tests also remain in the full suite.

The separately approved browser pass additionally verified real mock HTTP, SVG decode/download and three laptop viewport layouts; see `next-batch-status.md` for coverage and remaining gaps. Ordinary controls exhausted one synthetic principal's 32 retained interests with 24/40 work units spent. Cancelled interests remain counted until expiry plus retention, approximately one day with defaults. Capacity errors are now non-retryable with an explanation; immediate retry cannot free retained requests or restore lifetime budgets. No limits, ledger or budget were reset. This remains a significant prototype usability limitation.

This is synthetic diagnostic/cache-control evidence, **not measured image rendering latency**, visual parity, hardware performance, LCP, responsive art approval or G1 acceptance. No cloud resources, engine downloads, external submissions, paid calls, product approvals, customer cutover or publication occurred. Actual flag-off startup, physical-device qualification and deployment transport testing remain outstanding. Production services, authentication, isolation, procurement, rights, provider budgets and artifact storage remain unimplemented and unapproved.
