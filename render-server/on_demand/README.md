# Private native render worker

Source-level adapter for `fury.render-library@1` / `fury-native-five@2`.

Release 2 replaces the interior close-up with an end-corner room overview. Release 1
and its stored objects remain immutable. The four unchanged exterior seed cameras
remain compatible; historical interior pixels are deliberately excluded from both
server imports and browser fallback. New interior images require an explicit render.
The Container camera variant `fury-container-open-exterior-entry-cameras@1` keeps
operable doors open and places Interior Entry outside the selected opening. Doorless
openings retain the neutral `closed` metadata pose; no door exists to close. The
pipeline ID remains `fury-native-five@2`, but the full camera recipe participates in
every set/image hash. Studio identities and cameras are unchanged. Exact open-door
exterior seeds may be reused; closed-door seeds and historical interiors may not.

**This Container variant is not yet deployed or pixel-qualified.** Roll it out with
the matching pinned API/dispatcher/worker package and recipe registration, not the
frontend alone. Check and settle existing admitted work before switching package
pins; do not disable the always-on service or reset its cumulative budget. Existing
Studio cached images remain readable. A fresh Container render is still required
for visual acceptance. Importing these
modules, packaging source and running the tests do not invoke a GPU, Blender or Supabase.
The retired gateway remains disabled.

## Boundaries and customer flow

A dispatcher on the Vast host automatically drains **already admitted** durable
outbox rows. There is no operator command per customer job. The database enforces
budget, global capacity, per-session admission and exactly-once dispatch claims.
The daemon obtains the one-shot worker claim before trusted CPU preparation and
before any GPU work. A null/failed claim never starts a render slot.

The CPU preparation imports source-pinned geometry/material/camera code, not a
browser scene, renderer, arbitrary path or executable. Only missing views are
prepared; the selected camera comes first. An isolated render slot (UID 10001 or 10002)
receives the prepared package over private stdin, without service or provider credentials,
network access, secrets, public ports, HTTP endpoints or mounted storage. The supervisor
drops supplementary groups and root privileges before reading input. It runs
Blender 4.5.0/Cycles/OptiX, rejects CPU ray-tracing fallback, and requires 1024
non-adaptive samples, a completion handler and final-sample log evidence.
CPU denoising is intentional; it is not CPU path-tracing fallback.

Outputs are decoded WebP quality 95, exactly 1920×1200 or 1200×1500, at most 8 MiB.
The GPU streams 16 KiB chunks; the CPU independently decodes/checks them and uploads
to signed, non-upserting staging keys bound to job/attempt/image/checksum. The service
independently verifies and publishes immutable library artifacts. Progress is actual
render/save/verify activity, never a fabricated timer. Draft/unqualified provenance
remains explicit in the prepared manifests and recipe release.

## Lifetimes and no retries

- One GPU, one render child at a time; one CPU daemon consumes sequentially.
- DB global cap is two unsettled provider claims; queued reservations do not occupy GPUs.
  Minimum warm GPUs remain 0 and provider retries 0.
- Preparation ≤120 s, startup ≤180 s, each image process ≤300 s, at most five views.
- The slot watchdog enforces the remaining admitted lifetime, capped at 2100 s and
  approval/claim expiry.
- GPU stdin has a separate 180 s startup alarm. Process groups are killed/joined;
  child file size, package, stdout frame, aggregate output and image byte caps apply.

Provider starts are never retried automatically: an ambiguous start is quarantined
and reconciled, never resubmitted. This is not evidence of a provider billing bound.

## Build an offline, content-addressed package

Prerequisites: repository dependencies (`npm ci`, Node 24), Python 3.11. Python CPU
and GPU dependency closures have separate version/hash-locked requirements.

```sh
python scripts/native-render-package.py /absolute/fresh/native-package
```

The command copies a closed allowlist, never `.env`, credentials, git history,
`node_modules`, caches or local receipt folders. It verifies pinned asset bytes and
writes `native-build.json` plus `recipe.json`. Hashes cover the new scenery/compiler,
all downstream `src` geometry/material/camera/sky dependencies, assets, npm lock,
Python worker/renderer/protocol, Python locks and Dockerfiles. The CPU verifies the
closure and recipe before starting and before each preparation. Do not edit a built
package: rebuild, register a newly approved immutable recipe/build binding, and pin
the resulting deployed image ID. A source hash is not visual qualification.

`Dockerfile.cpu` and `Dockerfile.gpu` are build recipes, not deployed images. Build
only from the generated package with operator-approved digest-pinned Node 24 and
Python 3.11 Debian-bookworm base images (`NODE_IMAGE`, `PYTHON_IMAGE` build args).
GPU OS libraries are resolved by apt at build time; capture the final image digest
and OS package manifest for qualification—this is not a bit-reproducible OS build.
The GPU image contains no provider SDK, HTTP gateway or service transport. These Docker
builds and live image execution have **not** been validated in this implementation.

## Standalone dispatcher daemon (separate approval required)

The production path is the Vast-hosted dispatcher below. `python -m on_demand.dispatcher`
is an equivalent single-lane daemon that drives the warm worker through `VastProvider`.

1. Review/qualify the worker release, native pixels, exact device/sample logs,
   bounded termination and measured cost. Provision the warm host separately.
2. Register the exact generated recipe hashes in the service, set the same bounded
   liability ceiling in the worker policy and database admission policy, and obtain
   explicit spending approval/expiry. Never enable using the fixture hashes.
3. Run exactly one CPU replica per **persistent POSIX disk**. Allocate at least 8 GiB
   RAM and storage for preparation/spooled artifacts. Source image is read-only;
   `/var/lib/fury-native` is a 0700 persistent directory owned by UID 10001. SQLite
   uses WAL + FULL sync. The process holds an exclusive flock. Do not use ephemeral
   serverless filesystems, NFS SQLite, replicas sharing an uncoordinated journal, or
   journal rollback snapshots. Preserve the DB, WAL, spool files and provider proofs.
4. Supply CPU-only environment: `FURY_SERVICE_ORIGIN`, `FURY_WORKER_TOKEN`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, plus the `FURY_VAST_*` SSH settings.
   Never bake these into images, policy files, logs or GPU environment.
   Protected Vercel previews may additionally use a short-lived `VERCEL_OIDC_TOKEN`
   from the linked project's development environment. It is sent only to the configured
   worker API origin, never to Supabase, signed uploads or GPU containers. Refresh it
   before expiry; do not disable Deployment Protection to run a preview trial.
5. Create a root/operator-owned policy JSON, readable by the daemon:

   ```json
   {
     "enabled": false,
     "approvalId": "REPLACE_WITH_REAL_APPROVAL",
     "expiresAt": "2000-01-01T00:00:00Z",
     "maxJobLiabilityMicroUsd": 0,
     "globalBudgetMicroUsd": 0,
     "dispatcherId": "unique-persistent-cpu-host",
     "appName": "vast-warm",
     "imageId": "vast-warm",
     "providerKind": "vast-warm",
     "instanceId": "REPLACE_WITH_VAST_INSTANCE_ID",
     "recipe": "REPLACE_WITH_GENERATED_RECIPE_OBJECT"
   }
   ```

6. On a genuinely new installation only, initialize the journal once. This is an
   explicit operator action, never a startup/init-container command:

   ```sh
   export PYTHONPATH=/opt/fury/render-server
   python -m on_demand.dispatcher --policy /etc/fury/policy.json \
     --state /var/lib/fury-native --initialize-journal
   ```

7. Run the CPU image command under a host/container supervisor, with the persistent
   volume and policy mounted, a finite memory/disk budget, restart-on-failure and an
   alert for `reconciliation-pending` / `dispatch-paused-or-unavailable`. Default
   entrypoint is `python -m on_demand.dispatcher --policy /etc/fury/policy.json
--state /var/lib/fury-native`. Enable only after steps 1–6 and service admission
   approval. Stop the daemon before changing policy; restart replays metadata safely.
   Retain settled journals/proofs for audit; archive settled spool files with an
   operator-controlled retention policy, never delete active/uncertain state.

## Crash/reconciliation runbook

The journal records `creating` **before** the single creation call. Any crash after
that barrier is possibly billable. Resume only by saved `vast:<instance>:fury-{dispatchId}`
provider ID; never call create again, even if stdin was never sent.
The input is single-send too. A lost transfer waits for timeout, not resubmission.
Only deterministic metadata/upload delivery is replayed; no image is re-rendered.

**An absent job record is not proof that nothing ran.** Such jobs remain quarantined/reserved indefinitely pending independent
operator/provider reconciliation. Job expiry, a worker terminal event, a kill request,
a local exception or missing process is not termination evidence. The daemon polls
provider status independently; only an observed provider exit creates a timestamped,
hashed proof retained in the journal and permits terminal reconciliation. It charges
the exact durable per-job reservation conservatively, obtained through the fenced
`dispatch_reservation` RPC, not the current policy ceiling or a value in an old journal.
Missing reservation data blocks settlement. A later audited billing adjustment is
outside this worker.

Apply `202610190003_render_library_recovery.sql` before running this dispatcher. It adds
the service-only reservation read and permits only fenced `uncertain` → `accepted`
resolution to the discovered provider ID, never a new creation or provider replacement.
Artifact replay is best-effort and cannot block provider polling, termination requests
or independently proven settlement. An already-published artifact is acknowledged via
its exact event before any file read/upload, including after the claim deadline. Expired,
unpublished artifacts cannot publish; retained journal entries are not proof of a saved
library image. Settled jobs replay acknowledgements only, never uploads or renders.

If the journal/disk is lost, startup **refuses to initialize**. Disable service
admission and stop dispatchers. Inventory database dispatches/provider IDs and the
provider's independently observed allocations/bills; restore a consistent journal
from an audited backup or reconcile affected jobs manually through the service.
Do not create a fresh journal and replay consumed outbox rows; do not release unknown
liability; do not roll back IDs or reset jobs to pending. Re-enable only when all
unknown allocations and reservations are accounted for. A missing provider ID may
require provider support/administrative audit rather than automatic recovery.

## Integrator contract (no shared protocol edits)

CPU uses quoted PostgREST RPC argument names, confirmed with the service builder:

| RPC                                   | JSON arguments                       |
| ------------------------------------- | ------------------------------------ |
| `render_library_claim_dispatch`       | `{dispatcherId,lane?}`               |
| `render_library_record_dispatch`      | `{dispatchId, claimToken, result}`   |
| `render_library_dispatch_reservation` | `{dispatchId, claimToken}`           |
| `render_library_reconcile_terminal`   | `{jobId, evidence, chargedMicroUsd}` |

Worker claim/uploads/events use the three `WORKER_API_PATHS` with bearer auth.
Upload preparation and event posting bind the same entire artifact-event body.
`claim_dispatch` selects pending rows only: **no automatic expired consumed-lease
reclaim**. Provider IDs are `vast:<instance>:fury-{dispatchId}`. No schema extension
is needed for independent terminal evidence. The dispatcher sends a trusted,
claim-bound prepared package to the isolated render slot; the browser still sends
no scene/code/path/URL payload.

## Continuously available private dispatcher

The dispatcher runs on the retained Vast RTX 5090 host itself; there is no separate CPU
provider. `render-server/vast-dispatcher.sh` supervises two long-running lanes of
`render-server/hosted_dispatcher.py` as root: `foreground` handles the most recent
requests, `background` drains older work. Each lane polls the durable outbox every
3 seconds, handles one job at a time with its own journal under
`/var/lib/fury-dispatch/<lane>/dispatch.sqlite3`, and restarts after a crash. The
database caps unsettled dispatches at one per lane and two globally, even across restarts
and uncertain starts. Admission is independently bounded by the approved budget and unchanged hourly
quotas, not GPU occupancy. A click on **Bring your vision to life** is still required.
Cache lookup, page reload, changing a camera and restoring a shared design never admit work.
Queues are not GPU capacity reservations and cannot guarantee an immediate start.
GPU sampling, image quality and one-shot dispatch are unchanged. Worker protocol
compatibility requires the rollout described below; do not replace an immutable
registered build in place.

Preview credentials are branch-scoped. Merging or opening a new PR does **not**
copy that configuration. Before sharing a new preview, provision its exact
branch with the existing server-only secrets and public storage origin, set
`RENDER_LIBRARY_PUBLIC_ORIGIN` to its stable protected branch alias, and rebuild.
Do not broaden credentials to arbitrary preview branches or production. Verify
the deployed API returns five stored descriptors for a known completed set,
verify their downloaded hashes, and check an uncached design returns an honest
miss with enabled admission. A successful build alone does not prove connection.

Apply migrations `202610190004_hosted_dispatcher.sql` and
`202610190005_dispatcher_headroom.sql` after the existing migrations, then
`202610200001_render_queue_lanes.sql` only after worker compatibility review. CPU cycles
reserve a conservative maximum in the same cumulative approval ledger as GPU jobs,
then settle measured elapsed time. Crashed cycles keep their maximum charge; do not
refund them automatically. Configure `dispatcher_headroom_micro_usd=500000` on the
active approval to leave recovery capacity outside new GPU reservations.

Install on the Vast host (root):

1. Node 24.22.0 at `/usr/local/node` (checksum-verified tarball) and the pinned
   `/usr/local/bin/python` with `on_demand/requirements-cpu.lock`.
2. Copy the registered immutable native package to `/opt/fury-dispatch/<build>` and run
   `npm ci` there; write `<build>` to `/etc/fury/dispatch-build`. Use the registered
   package, not a freshly repackaged source tree with a different recipe hash.
3. Copy `hosted_dispatcher.py`, `vast_host.py` and `vast-dispatcher.sh` to `/opt/host`.
4. Write `/etc/fury/dispatcher.env` (root, mode 0600) with `FURY_SERVICE_ORIGIN`,
   `FURY_WORKER_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VERCEL_TOKEN`,
   `FURY_VERCEL_PROJECT`, `FURY_VERCEL_TEAM`, `FURY_DISPATCHER_ID` and `FURY_VAST_INSTANCE`.
   Render slots run as UIDs 10001/10002 and never see this file.
5. Start both lanes and add the same line to `/root/onstart.sh` so they survive restarts:

```sh
for lane in foreground background; do
  nohup setsid /opt/host/vast-dispatcher.sh $lane >> /var/log/fury-dispatch-$lane.log 2>&1 < /dev/null &
done
```

Journals are created empty on first start; never delete or reinitialize an existing
journal. Missing provider state fails closed; ambiguous starts remain quarantined,
never automatically retried. Render slots receive no service credentials.

The protected preview's development OIDC token is refreshed every 15 minutes through
the Vercel API. Keep the service origin aligned with the API's allowed origin.
Enable the approval only after the journal is initialized and recipe validation
passes. An enabled idle probe returns `status: idle`; `recovery-pending` requires
investigation, not a second GPU submission. Observe CPU cycles in
`render_library_dispatcher_cycles` and dispatch/job state in the existing tables.

The approved $1,000 allowance is cumulative (`budget_micro_usd=1000000000`), not a
daily reset. Keep the approval enabled after tests. At exhausted compute capacity,
new GPU jobs are denied and the dispatcher lanes idle; Vercel/Supabase cached-image
reads remain available. Restarting after exhaustion requires a newly authorized
budget, and clearing `dispatcher_halted` under operator control, not resetting
charged balances. A failed CPU reservation returns `budget-busy` while a sibling cycle can
still be running; it must not stop that sibling lane. The transactional halt RPC fences
new cycles before returning `budget-exhausted`. A crashed cycle retains its full charge;
never a GPU liability refund. The ledger is conservative application accounting,
not a verified Vast invoice or an account-wide billing cap; warm-host rent, network and
hosting bills must be monitored separately.

Foreground dispatch prioritizes the most recently requested pending selection across sessions.
If none is eligible, it uses idle capacity for older queued work; background remains FIFO.
Cached or terminal selections therefore cannot strand pending work behind a busy background lane.
Approval expiry pauses unclaimed jobs without cancelling their reservations or authorizing
post-expiry spending. Operator renewal of the approval and matching policy resumes that same
durable backlog; expiry is not an automatic refund or cancellation mechanism.

### Compatible queue-worker rollout

The original `fury-native-five@2` package validates
`maxActiveJobsPerSession` as exactly 1. The queue worker permits 2. This source change is **not a
drop-in deployment of that archived package**: the image-build preflight deliberately
rejects a worker that cannot accept the two-job ceiling. The new schema still accepts
old one-job claims for recovery, but the old schema cannot accept new claims.

Build the execution-only upgrade from the exact registered archived source closure, not
the current application checkout:

```sh
python scripts/native-render-package.py --queue-upgrade /path/to/verified/archive /path/to/new-package
```

The command verifies every archived file and registration hash, then makes only the audited
TypeScript/Python limit changes. The manifest identifies `fury-native-queue-worker@1`, its
parent build, and exact changed-file hashes. Geometry, materials, cameras, renderer code,
assets and image keys remain unchanged. Broad bundle/renderer aggregate hashes change
because they also cover execution validation; they must not be misrepresented as the old build.

Register the new package in the additive, immutable `render_library_worker_builds` table;
never overwrite `render_library_recipes`. Keep the approval's original `policy.recipe`
unchanged so existing customer APIs remain compatible. Only the separate
`active_worker_build_sha256` selects execution. The dispatcher resolves that registration;
the worker API validates historical events using each job's stored build, even after cutover.

Deploy the compatible API to an explicitly credential-scoped trusted preview. Build a new
GPU image with the upgraded `recipe.json`; the old GPU image cannot run new-build claims.
Apply the queue and worker-build migrations atomically, retaining all balances and evidence.
Dispatch claims carry the worker build hash. Legacy callers without that hash can only claim
while the original build is active; mismatched dispatchers leave queued work untouched.
Until activation, claims retain the original one-job ceiling. Preserve the original journal,
initialize **only** the background journal, and drain existing provider work before replacing
the dispatcher. Select the new build to fence legacy dispatchers, then deploy both functions
with `FURY_NATIVE_PACKAGE`, `FURY_GPU_IMAGE` and `FURY_SERVICE_ORIGIN` pinned together.
The latter two override only those settings, retaining the existing named credentials.
Queued admissions remain durable during this handoff. Do not stop customer admissions as test cleanup.

Rollback requires draining/reconciling in-flight new-build work first, retaining the upgraded
API's historical validation and both journals. Select the old build and redeploy its original
dispatcher/image together; do not feed old workers two-job claims or delete queued liabilities.
The old single-lane dispatcher cannot service all background backlog: preserve that backlog
for the restored two-lane deployment. Keep uncertain reservations occupying their slots.
Verify two separate GPU jobs, durable overflow, and a saved-image cache hit before claiming
hosted readiness; a successful deployment alone proves none of these.

## Offline checks and explicit fidelity holds

```sh
node --import ./scripts/native-render-register.mjs scripts/native-render-selftest.ts
node --import ./src/render/prototype/register.ts scripts/native-render-contract-fixtures.ts
npx vitest run src/render-library
python -m unittest discover -s render-server/on_demand/tests -p test_contract.py
# In an isolated Python 3.11 environment with requirements-cpu.lock installed:
python -m unittest discover -s render-server/on_demand/tests
python -m compileall -q render-server/on_demand
npm run typecheck && npm run lint && npm run format:check && npm run build
```

The fixture generator can update shared schema fixtures; the integrator owns those
changes. Runtime tests use explicit provider/service/transport doubles, real decoded
synthetic WebPs, and the real pinned SDK request path—not real provider execution.
Preparation checks all eight customer looks, distinct courtyard/campus/desert geometry,
Day/Night sky/light differences, analytical environment orientation, all five cameras,
selected-camera-first ordering and tall dimensions.

Outdoor scene support retains authored buildings, placement/seeds, ground scans,
hardscape, seating, planters, tree limbs, palms, shrubs, flowers, grass and procedural
sky. It does **not** replace them with stock scenery or a relabelled studio. Fidelity
holds remain: triangulated canvas leaf/flower silhouettes lack exact gradient/vein
shader parity and bent normals/translucency; grass uses midpoint colors; native ground
uses the existing path-tracer scan representation rather than raster anti-tiling.
Existing prototype construction material/equipment-console limitations remain in
the manifest too. No native outdoor pixels, live sky orientation, new package GPU
execution, storage integration, startup latency, final sample-log format or provider
hard-stop/billing bound has been visually/live qualified. Do not enable production
admission solely because these offline checks pass.
