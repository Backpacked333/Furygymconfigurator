# Warm Vast RTX 5090 rendering

Saved stills remain the default gallery. Only an explicit **Bring your vision to life**
request admits rendering. Entering 360°, changing options, hiding the tab, or closing
the page does not cancel admitted work or request another render.

## Queue and capacity

- Admission atomically saves the exact design, image identities, idempotency key,
  budget reservation, job and dispatch outbox in Supabase. Changes to the currently
  displayed design cannot rewrite that saved build. Matching requests join existing work.
- A waiting job occupies no GPU slot. The foreground lane prioritizes the latest
  explicit request; the background lane drains older requests FIFO without cancelling them.
- One warm **RTX 5090** supplies **two isolated render slots sharing one GPU**. This
  is not two GPUs or a claim of twice the throughput. Execution remains capped at two.
- The warm-worker profile allows 60 new requests/session/hour, 120/network/hour and
  240 globally/hour, still subject to the unchanged monetary reservation limits.
  Legacy L40S admission retains its 3/6/12 limits. Refused requests return explicit errors.
- Submission snapshots the design before waiting for authentication and uses Fetch
  keepalive for the admission POST. An accepted server response confirms persistence;
  an offline or unconfirmed submission must not be described as already admitted.
- Image publication requires independent WebP decoding, dimensions, byte count,
  SHA-256 and build-bound receipt verification. Reopening an exact saved design is free.

## Provider boundary

The existing scheduled **Modal CPU dispatcher** and its durable lane journals remain;
**no Modal GPU is created** for the warm Vast profile. The CPU dispatcher connects over
SSH to an operator-provisioned instance. It has no rental-creation or rental-deletion path.
The Vast API key is not needed by the dispatcher or sent to the GPU.

Each job has a deterministic provider identity containing the instance and dispatch ID.
An fsynced creation record precedes process launch. Recovery never resends a partially
transferred package. Reconciling an absent creation writes a tombstone under the same
lock, preventing a delayed creation from starting afterward. PID start-time checks
prevent accidentally terminating a reused PID.

The root supervisor supplies an immutable, hash-verified source release and drops the
renderer to dedicated UID 10001 or 10002. Slot homes are private. Renderer processes
inherit a fail-closed seccomp filter denying IPv4/IPv6 sockets and io_uring, but allowing
local CUDA IPC. No application/provider credentials enter the render environment.
The watchdog bounds startup and execution; termination kills the job's process tree
and confirms the slot is no longer running before publishing terminal evidence.
The **rented host remains running** after success, failure, reconciliation and idle time.

Full quality remains Blender 4.5.0, Cycles/OptiX, 1,024 completed samples,
non-adaptive sampling, WebP quality 95 and no CPU ray-tracing fallback.
Receipts must match the immutable registration's GPU; historical L40S receipts stay valid.

## Installation and cutover

1. Use a verified on-demand single-5090 host with working SSH, a pinned SSH host key,
   and the NVIDIA graphics/compute capabilities needed for OptiX. Never suppress host-key
   verification or silently fall back to CUDA/CPU if OptiX libraries are missing.
2. Build a fresh closed source package with
   `python scripts/native-render-package.py --vast-upgrade VERIFIED_BASE NEW_PACKAGE`.
   This verifies the base, preserves its pixel-producing sources and permits only the
   enumerated worker/runtime changes. The base need not be the deployed worker: record
   its actual hash and any intervening camera/source changes honestly in registration evidence.
3. Install the package at `/opt/fury/releases/WORKER_BUILD_SHA256`, retaining old releases
   needed by unsettled jobs. Install the package's hash-locked GPU requirements and the
   headless Blender libraries, including `libseccomp2`. Run
   `python setup_vast_worker.py /opt/fury/releases/WORKER_BUILD_SHA256 INSTANCE_ID` as root.
   This verifies every source hash and hardware identity and prepares the two private slots.
4. Prove real full-quality rendering through `VastProvider`, not just `nvidia-smi`.
   Check samples, OptiX, image bytes, concurrent slot isolation and terminal reconciliation.
5. Deploy compatible worker API routes, apply the warm-profile/backlog migrations, and
   register the immutable worker build. Retain the original recipe registration and
   approval recipe: provider changes must not invalidate existing cached image identities.
6. Store `FURY_PROVIDER=vast-warm`, `FURY_VAST_HOST`, `FURY_VAST_PORT`,
   `FURY_VAST_INSTANCE`, `FURY_VAST_SSH_KEY` and `FURY_VAST_KNOWN_HOSTS` in the private
   `fury-render-library-vast-worker` Modal secret. Never commit these credentials.
7. Deploy `render-server/deploy_dispatcher.py` with `FURY_PROVIDER=vast-warm`,
   `FURY_NATIVE_PACKAGE`, and the paired `FURY_SERVICE_ORIGIN` / `FURY_GPU_IMAGE`
   overrides. For Vast the latter is a descriptive pinned host identity, not a Modal image.
   Keep deployment-protection credentials restricted to the worker API origin.
8. Fence the approval to the registered build only after old jobs are reconciled.
   Do not initialize over existing journals or reset accumulated charges/reservations.
   Verify the real product CTA, all five saved views, exact lookup reuse and backlog
   survival after editing or leaving the page before declaring the cutover complete.

## Operating costs and recovery

Warm-instance hourly rent continues while idle and is **separate from the per-job
admission ledger**. The ledger conservatively reserves/charges job liability ceilings;
it is not a live Vast invoice or a cap on an explicitly retained rental's idle costs.
Budget exhaustion stops new admitted work, not the warm GPU rental. Monitor Vast credit,
actual rental charges, queue age, host health and disk usage separately.

Completed input packages are removed after durable reconciliation; structured logs and
terminal records remain for recovery. Archive/prune only settled records under an
operator-controlled retention policy. Never delete live spool directories or journals.
If the host is unreachable, leave work uncertain and retain its liability; do not create
another rental or replay ambiguous input. Restore the same host/SSH connection and let
the dispatcher reconcile. Any host shutdown or added GPU capacity requires authorization.
