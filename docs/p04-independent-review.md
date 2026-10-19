# P04 independent adversarial review

## Parent remediation addendum — after the original review

The original findings and 26-test evidence below are historical and preserved for traceability. After that review, the parent implemented R1–R3 repairs, converted the four `KNOWN GAP` tests into safe regressions, and added bounded-operation and separate-process hung-stop tests. Final verification is recorded in the P04 handoff's `final-verification.json`; it is a parent rerun, **not a second independent reviewer approval**.

R1 now persists authenticated finality contradictions as execution-specific quarantine/audit evidence, kills new admission, retains an explicit unknown liability and blocks retention of the affected job. Settled balances/receipts remain immutable. Historical nonfinal inventory receives a stop attempt even if the execution ID is old. No automatic resolution/reset exists.

R2 now bounds asynchronous provider waits and outstanding operations; timed-out calls keep their slots rather than multiplying each tick. Local streams close before provider awaits. Separate-process testing uses a never-resolving first stop and verifies another stop progresses and unresolved liability survives. External host termination, blocked synchronous calls and independent infrastructure scheduling remain unqualified.

R3 now captures a local cleanup cutoff before its reference snapshot; a deterministic interleaving verifies the newly active stage survives. This assumes a shared nondecreasing local clock. It does not solve distributed deletion epochs, clock rollback, CDN invalidation or backup erasure.

All external/provider/production and legacy-cutover holds in the original review remain. The following verdict describes the original pre-repair revision, not an assertion that these defects remain unfixed.

## Verdict

**INCOMPLETE — not approved for paid execution or production.** The inspected local control plane has meaningful fail-closed controls, but this review reproduced three unresolved safety/recovery gaps in four adversarial characterizations. Existing provider, signed-delivery, retention, legacy-cutover, and operational holds also remain.

On 2026-10-18, the independent review suite ran **26/26 tests with passing assertions**: **22 guardrail tests and four `KNOWN GAP` characterizations**. The latter deliberately assert the unsafe behavior described below. A green test report therefore **does not mean that all safety requirements pass**. When fixing a gap, replace its characterization with assertions of the intended safe behavior; do not leave the unsafe outcome as the acceptance criterion.

No implementation, frozen contract, frontend default, legacy renderer, existing ledger, or another agent's evidence was edited. Only this report, the new independent test file, and uniquely named independent-review evidence were written. No GPU/CPU renderer, paid API, cloud mutation, deployment, dependency installation, UI/browser test, git commit, or branch change was performed.

## Scope and evidence

Inspected the actual `src/image-service/control-plane/{contracts,ledger,worker,watchdog,provider,objects,service,api,auth}.ts`, the P04 safety and provider documents, and retained frontend/legacy paths. Tests use real local SQLite, filesystem objects, the deterministic fake provider, and real loopback HTTP. Narrow provider wrappers introduce a never-resolving stop and authenticated contradictory inventory; object hooks inject publication faults. Test stores use unique `independent-review-store-*` directories in the handoff and are removed after each test. Existing ledgers/budgets are untouched.

The independent fixture and HTTP/auth setup are in `src/image-service/control-plane/independent-review.test.ts:35–162`. Authentication keys are random disposable test values and are not printed. The runner uses an explicit environment allowlist, Node **v24.22.0**, one Vitest worker, and a handoff-local cache/temp directory.

Latest evidence directory: `/home/ubuntu/Documents/fury-p04-handoff/independent-review-run-6jTqVl/`:

- `vitest.json`, `vitest.log`: 26 tests, one file, all assertions passed; four are gap characterizations.
- `typecheck.log`: targeted strict TypeScript check of the owned test and imported dependency graph, exit 0.
- `eslint.log`: owned test only, exit 0.
- `checks.json`: exact commands, exit statuses, timings, and environment description.

Earlier `independent-review-run-N16zCd/` records the first successful 25-test run, before adding the historical-execution kill characterization. It is not the final count. The full repository suite/build and existing integration/child-process suites were **not rerun** by this reviewer. Reopening a ledger handle in this suite tests persistence, not a new process or power-loss durability.

## Findings requiring integrator action

### R1 — High: post-settlement provider contradictions are discarded, including during kill

**Code:** `ledger.ts:1094–1106,1119–1134`; `watchdog.ts:145–169`. Paths in this section are relative to `src/image-service/control-plane/`.

`acceptReceipt` verifies the signature and execution identity, but rejects any nonidentical receipt for an inactive/already-settled execution before checking its cost/runtime bounds. Exact replay must remain idempotent; a newer, authenticated contradiction is different. It currently produces no durable breach event, kill, or unresolved-meter liability.

**Reproduction A:** `independent-review.test.ts:348–374` completes a real fake-provider job, then submits a correctly signed newer final receipt above the job's total quote and runtime cap. `recordReceipt` returns false. Reopening the ledger shows kill still false and unchanged global accounting; the job remains ready with zero reservation and no reconciliation requirement, its events are unchanged, and a different design/principal is admitted. This is not an unsigned-client attack: it characterizes provider/adapter finality failure, an expressly unresolved production requirement.

**Reproduction B:** `independent-review.test.ts:376–406` substitutes correctly signed `running`, nonfinal inventory for an execution previously settled in the ledger. `watchdog.kill()` persists kill but reports zero stop attempts, zero retained liabilities, zero orphans, and no errors. The historic ID in the event log makes the watchdog skip the resource regardless of its contradictory current state. This does **not** show that the normal LocalFakeProvider resurrects tombstoned work. It shows that the watchdog assumes historic finality rather than handling evidence that contradicts it. The worker's inventory guard (`worker.ts:203–219`) independently rejects dispatch against nonfinal inventory absent from active ledger executions; that guard must not be confused with actually stopping the resource or correcting accounting.

**Required action:** distinguish exact replay/older receipt from authenticated newer contradictory evidence. Durably quarantine/audit the latter, stop further admission, retain an explicit unresolved liability, and reconcile provider evidence without silently rewriting final receipts or fabricating a refund. Audit historic inventory state rather than skipping solely by ID. Coordinate the contract/accounting representation with its owner: current terminal-job invariants (`ledger.ts:469`) disallow simply marking a terminal job reconciliation-required. No frozen interface was silently widened in this review.

### R2 — High for an external adapter: unbounded provider awaits block the independent watchdog

**Code:** `watchdog.ts:54–69,91–106,112–142,185–209,233–261`; analogous worker waits at `worker.ts:80–94,237–240`.

Stop calls are awaited serially without a watchdog-owned deadline. Inventory and receipt reads are also unbounded awaits. A single promise that never resolves can keep the pass pending, prevent subsequent resource stops, and postpone stream closure. `tick()` shares the in-flight pass, so another scheduled tick does not escape it. Persisting kill first correctly blocks new ledger work, but does not establish progress on already-running resources.

**Reproduction:** `independent-review.test.ts:408–449` creates two uncertain executions and a durable simulated stream, then makes the first provider stop wait on a test-controlled unresolved promise. After a 30 ms observation window, kill is durable but the kill call is still pending, only one stop was attempted, and the stream remains stop-requested. Releasing that promise lets the pass proceed. Thirty milliseconds is an observation window, not a claimed production shutdown SLA; the blocked promise has no natural completion.

**Required action:** bounded inventory/receipt/stop deadlines, bounded independent per-resource progress, and stream handling that cannot be starved by an unrelated provider call. A timeout must retain uncertainty/reservations, not count as stopped proof. Bound outstanding timed-out operations too, rather than accumulating promises on each tick. Qualify this with separate-process failure tests and real-provider termination/metering evidence before any paid adapter. The current local fake resolves normally; the injected failure is an external-adapter liveness gap, not evidence of live GPU spend.

### R3 — Medium: stage recovery can delete a newly live execution's stage from a stale snapshot

**Code:** `watchdog.ts:185–209`; `objects.ts:744–784`.

The watchdog snapshots active executions, then supplies a later `now()` as the cleanup cutoff. `ObjectStore.recover` trusts the caller's active-ID snapshot and removes stages older than that cutoff if absent from it. A worker in another process can claim and stage between those operations.

**Reproduction:** `independent-review.test.ts:451–468` captures the old ledger snapshot, claims/begins a new execution, stages its real deterministic artifact, advances the test clock, and invokes recovery with the old active IDs and newer cutoff. Recovery reports one stage removed while the ledger still has the live execution; publication then fails with 503. This is a deterministic reproduction of the problematic snapshot ordering, not a probabilistic cross-process stress run. It demonstrates lost work/retry pressure, **not** a checksum bypass, stale-ready publication, or deletion of a referenced immutable object.

**Required action:** coordinate recovery with an authoritative deletion/GC epoch or equivalent fenced protocol. At minimum the local stage-age cutoff must precede the snapshot it authorizes, with explicit clock assumptions; cross-process/remote stores need stronger qualification. Preserve unknown partial stages conservatively. The separate immutable-object deletion-lease/CDN-erasure gap already documented in `docs/p04-safe-image-service.md:43–49,89–97` is not resolved by such a local cutoff adjustment.

## Guardrails actually exercised

All test references below are in `src/image-service/control-plane/independent-review.test.ts`.

| Boundary                                | Independent result                                                                                                                                                                                                                                   | Test lines |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Coalescing, principal rotation, restart | Public coalescing does not reserve a second job; a new principal/design cannot bypass the global budget after reopening SQLite.                                                                                                                      | 166–187    |
| Identity/interest row growth            | Configured identity/interest capacity rejects further rotating principals without growing those rows. This is a bounded-cap test, not an exhaustive physical-disk growth proof.                                                                      | 189–198    |
| Retries                                 | Known failed attempts consume the already-reserved attempt allowance; attempts exhaust without a new reservation.                                                                                                                                    | 200–217    |
| Delayed start after kill                | Kill before provider execution creates a persistent start-forbidden tombstone; an old signed context does not start work.                                                                                                                            | 219–234    |
| Stop request versus proof               | Delayed stop and delayed final metering retain uncertain liabilities. Durable simulated streams do not become stopped proof.                                                                                                                         | 236–253    |
| Provider-only orphan                    | An unresolved provider-only execution blocks worker dispatch and remains a watchdog-reported liability. Historical-ID contradictions are the separate R1 exception.                                                                                  | 255–272    |
| DB failure before launch                | A SQLite trigger aborts checkpoint UPDATE during claim; the transaction rolls back claim/fence/events and provider dispatch does not happen. This is a real SQL write failure, not merely an exception stub.                                         | 274–292    |
| Publication kill race                   | Kill injected between filesystem publication and ledger CAS prevents ready state.                                                                                                                                                                    | 294–316    |
| Publication integrity                   | Injected readback failure prevents ready state; no unverifiable manifest is returned. This complements code inspection of exclusive links, signed descriptors, readback/checksum checks, and current-fence CAS.                                      | 318–336    |
| Shared delivery bytes                   | Coalescing across principals does not increase the shared artifact delivery-byte allowance.                                                                                                                                                          | 338–346    |
| Private exports and link leakage        | Real HTTP rejects another principal/experiment with 404, anonymous access with 401, and query-token routes with 400; authorized delivery is 200, `private, no-store`, attachment disposition, and explicitly MOCK. An ID alone is not authorization. | 470–492    |
| Forbidden fields/auth in body           | Ten forbidden/unknown top-level fields return 422 before any job/interest admission, including asset URLs, meshes, camera, samples, script, callback, worker command, priority, auth, and output-profile override.                                   | 494–512    |
| Nested schema/body cap                  | A presentation override with `samples` is rejected with 422; an oversized JSON body is 413, with no admitted jobs.                                                                                                                                   | 514–530    |

Inspection supports atomic requested/reserved/queued event capture, serial SQLite admission, bounded rows/events, fenced attempts, exact-idempotency lookup, conservative uncertainty, and object checksum verification before readiness. These are scoped local observations, not proof of external provider invoice completeness, physical DB/WAL/metadata quotas under arbitrary I/O failure, or all possible races.

## Frontend and provider-claim review

### Frontend/legacy separation

`src/render/traceStatus.ts:21–38` still selects the legacy cloud URL, and `src/render/renderSession.ts:26–76` still creates a legacy session and calls `/warm`. `render-server/modal_app.py:26–90` contains independent GPU/warm/timeout configuration. These paths are outside the P04 ledger; P04 kill is not a global kill for that retained renderer. This is a **paid-cutover blocker**, not permission to change the protected default UI/legacy lane here. No endpoint was contacted and no Python renderer module was imported.

Inspected prototype copy remains cautious: `src/prototype/ImageConfigurator.tsx:320,649,722,761` labels local/DRAFT/no-paid-fallback and open engineering/rights gates; `src/prototype/DesignPanel.tsx:164` explicitly denies paid/production approval. The new HTTP test observes MOCK output. This is source inspection, not UI testing or a comprehensive legal review. No new P04 frontend claim of approved rights, proven provider durability, or production-ready imagery was established by the inspected material.

### Current provider ADR

`docs/p04-provider-decision.md:3,12,39,67` correctly presents a proposed architecture, conditional provider preference, and unresolved contract/operational evidence. Its capabilities are not receipts proving that an account, deployment, permission, independent watchdog, or jurisdictional arrangement exists.

Independent public-source checks support these important caveats:

- Vercel documents scoped signed URLs, not merely authenticated Function proxying; its spend checks happen every few minutes and pausing production does not delete billed storage. These support ADR lines 19 and 51–52, not an instantaneous application budget/kill guarantee.
- Supabase documents absent S3 versioning and permanently deleted objects; its Smart CDN can retain cached signed responses beyond token expiry; spend caps exclude compute/PITR. These support ADR lines 18 and 49–53, not AWS feature equivalence or immediate revocation.
- AWS documents conditional create-only writes; CloudFront checks signature expiry at request start, so an in-progress download may finish after expiry. These support ADR lines 17 and 51, not a PostgreSQL/S3 transaction or termination of an existing stream.
- Modal documents independent parameter pools, indefinite deployed-app crash rescheduling, delayed billing collection, retention/routing caveats, and workspace versus environment budgets. Environment budgets exclude storage/reservations/network egress. These support ADR lines 59–67, not a per-job final-meter receipt or finite termination bound.
- A direct public pricing-page check confirmed the ADR's Modal L40S, CPU, memory, volume, and egress unit-price examples. Unit prices do not establish an approved total quote, plan availability, bounded tails, or invoice completeness.

The checked subset did not reveal a contradictory vendor-capability claim that warrants replacing the ADR's cautious conclusions. **The entire source register, commercial terms, exact account entitlements, and all numerical/region/backup claims were not independently revalidated.** Source observations are in `/home/ubuntu/Documents/fury-p04-handoff/independent-review-provider-checks.json`; exact bounded CloudFront/Vercel-spend/Modal-pricing excerpts, HTTP statuses, retrieval times, and source SHA-256s are in `independent-review-official-excerpts.json`.

Editorial issue: the frozen-contract line references in ADR line 39 are stale. In this inspected version, receipt finality is around `contracts.ts:577–619`, request binding at `385–404`, artifact identity at `631–696`, and `ObjectStore` begins at `896`, not the ADR's older `321–351`/`491–498` references. The contract owner/integrator should refresh anchors, without silently changing semantics. Also, proposed minimization/retention is not implemented erasure proof: the bounded ledger retains full job design data (`ledger.ts:125,818`) in its durable history; expiring/deleting an artifact (`ledger.ts:1454–1478`) does not itself erase that metadata.

## Remaining release gates

Keep `paidExecutionAllowed: false` and `productionAllowed: false`.

1. Resolve R1–R3 and replace their unsafe characterizations with safe regressions. Coordinate shared-file/contract edits with the implementation owners; no runtime fix is claimed here.
2. Establish real-provider stopped/start-forbidden proof, complete final metering, finite startup/idle/shutdown/retry/crash-loop/late-billing bounds, orphan visibility, least privilege, and independently progressing watchdog operation. Stop-request acknowledgement and synthetic signed claims are insufficient.
3. Resolve artifact-scoped signed delivery/expiry/revocation and cache/delivery-budget enforcement, including in-flight responses and exports. The current authenticated `no-store` route is narrower than a signed CDN URL and is not evidence for the latter.
4. Resolve fenced retention/deletion, full-design metadata minimization/retention, backups/version replicas/CDN/browser behavior, and physical storage/DB/WAL quotas with restore drills. Logical row/byte caps and local fsync are not cross-provider durability/erasure qualification.
5. Resolve production identity, grants/revocation, key custody, operator access, incident ownership, approved jurisdiction/retention/rights, supported account plans, and an approved provider ADR. No approval was inferred from vendor documentation.
6. Cut over or independently disable legacy paid/warm paths before claiming universal cost enforcement. Preserve protected default/P03/history lanes until that change is explicitly authorized.
7. Integrator should run its owned full-suite/build/check sequence with one worker and review boundary results; this review intentionally ran only the owned focused tests.

## Reproduction commands

From `/home/ubuntu/Documents/fury-p04`:

```sh
PATH=/home/ubuntu/.nvm/versions/node/v24.22.0/bin:$PATH /home/ubuntu/.nvm/versions/node/v24.22.0/bin/node /home/ubuntu/Documents/fury-p04-handoff/independent-review-run.mjs
```

The runner creates a fresh evidence directory, runs only the independent test file using Vitest `maxWorkers: 1`, then targeted TypeScript and ESLint. Source research used unauthenticated official documentation GETs; the source-check script writes with exclusive-create semantics and will not overwrite existing evidence. No existing budget/ledger reset is part of reproduction.
