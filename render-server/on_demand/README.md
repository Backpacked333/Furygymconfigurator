# Private native render worker

Source-level adapter for `fury.render-library@1` / reserved `fury-native-five@1`.
**Not deployed, pixel-qualified, registered or authorized to spend.** Importing these
modules, packaging source and running the tests do not invoke Modal, Blender or Supabase.
The retired gateway and `render-server/modal_app.py` remain disabled.

## Boundaries and customer flow

A dedicated non-root CPU process automatically drains **already admitted** durable
outbox rows. There is no operator command per customer job. The database enforces
budget, global capacity, per-session admission and exactly-once dispatch claims.
The daemon obtains the one-shot worker claim before trusted CPU preparation and
before any GPU allocation. A null/failed claim never creates a Sandbox.

The CPU preparation imports source-pinned geometry/material/camera code, not a
browser scene, renderer, arbitrary path or executable. Only missing views are
prepared; the selected camera comes first. A named single-use L40S Sandbox receives
the prepared package over private stdin, without service or provider credentials,
network access, secrets, public ports, HTTP endpoints or mounted storage. It runs
as UID/GID 10001: the supervisor drops supplementary groups and root privileges
before reading input because Modal ignores image `USER` instructions. It runs
Blender 4.5.0/Cycles/OptiX, rejects CPU ray-tracing fallback, and requires 1024
non-adaptive samples, a completion handler and final-sample log evidence.
CPU denoising is intentional; it is not CPU path-tracing fallback.

Outputs are decoded WebP quality 95, exactly 1920×1200 or 1200×1500, at most 8 MiB.
The GPU streams 16 KiB chunks; the CPU independently decodes/checks them and uploads
to signed, non-upserting staging keys bound to job/attempt/image/checksum. The service
independently verifies and publishes immutable library artifacts. Progress is actual
render/save/verify activity, never a fabricated timer. Draft/unqualified provenance
remains explicit in the prepared manifests and recipe release.

## Lifetimes, no retries, and SDK constraint

- One GPU, one render child at a time; one CPU daemon consumes sequentially.
- DB global cap must be ≤2 active/reserved jobs, minimum warm GPUs 0, provider retries 0.
- Preparation ≤120 s, startup ≤180 s, each image process ≤300 s, at most five views.
- Sandbox hard timeout and idle timeout are both the remaining admitted lifetime,
  capped at 2100 s and approval/claim expiry. Idle timeout is not shorter than a render.
- GPU stdin has a separate 180 s startup alarm. Process groups are killed/joined;
  child file size, package, stdout frame, aggregate output and image byte caps apply.

Modal Functions are not used: container failure retries are not a finite billing bound.
Modal 1.1.4's `Sandbox.create` itself retries its creation RPC by default. The isolated
one-shot **provider subprocess** temporarily overrides only SandboxCreate's retry
parameters (`max_retries=0`, 150 s RPC timeout), restoring the original function in
`finally`. No concurrent dispatch shares that subprocess. Exact installed version
and SHA-256 of `sandbox.py`, `client.py` and `grpc_utils.py` must match the audited
source; drift fails closed. The test exercises the actual SDK create/resolver/request
path with a fake transport accepting then disconnecting, and asserts one RPC only.
This is not evidence of a live provider billing bound; qualification is still required.

References: [Sandbox lifecycle](https://modal.com/docs/guide/sandboxes),
[Sandbox reference](https://modal.com/docs/reference/modal.Sandbox),
[Function retries](https://modal.com/docs/guide/retries).

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
The GPU image contains no Modal SDK, HTTP gateway or service transport. These Docker
builds and live image execution have **not** been validated in this implementation.

## Deploy the CPU runtime (separate approval required)

1. Review/qualify CPU and GPU image digests, native pixels, exact device/sample logs,
   bounded allocation/termination and measured cost. Provision the private Modal app
   and immutable GPU image separately. Runtime only uses existing app/image IDs.
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
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`.
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
     "appName": "approved-private-modal-app",
     "imageId": "im-APPROVED_IMMUTABLE_IMAGE",
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
that barrier is possibly billable. Resume only by saved `sb-...` ID or deterministic
name `fury-{dispatchId}`; never call create again, even if stdin was never sent.
The input is single-send too. A lost transfer waits for timeout, not resubmission.
Only deterministic metadata/upload delivery is replayed; no image is re-rendered.

`from_name` finds running Sandboxes only. **Name absent is not proof of no allocation
or no spend.** Such jobs remain quarantined/reserved indefinitely pending independent
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
| `render_library_claim_dispatch`       | `{dispatcherId}`                     |
| `render_library_record_dispatch`      | `{dispatchId, claimToken, result}`   |
| `render_library_dispatch_reservation` | `{dispatchId, claimToken}`           |
| `render_library_reconcile_terminal`   | `{jobId, evidence, chargedMicroUsd}` |

Worker claim/uploads/events use the three `WORKER_API_PATHS` with bearer auth.
Upload preparation and event posting bind the same entire artifact-event body.
`claim_dispatch` selects pending rows only: **no automatic expired consumed-lease
reclaim**. Provider IDs are opaque `sb-...`, not Function-call IDs. No schema extension
is needed for independent terminal evidence. The source protocol comment that says
only the dispatch envelope reaches Modal needs clarification by the integrator:
the CPU sends a trusted, claim-bound prepared package to the private Sandbox; the
browser still sends no scene/code/path/URL payload.

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
