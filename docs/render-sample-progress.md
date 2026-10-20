# Measured sample progress

The configurator reports saved views plus the current image's measured Cycles samples.
The bar uses `(readyViews + currentSamples / 1024) / 5`; it is view-weighted work, **not**
an ETA. At 1024 samples, denoising, encoding, delivery and verification may still be running.
Only five verified images count as a complete set.

## No render-path changes

`scripts/render-sample-monitor.py` is a separate, best-effort CPU observer. Every two seconds
it reads the bounded tail of existing Blender logs for live, cold renderer children under
the two fixed Vast lane directories. It binds each observation to the process's image
argument and prepared job/attempt/fence/camera. It never imports Blender, changes samples,
signals a renderer, reads image blobs or writes to the dispatcher journal.

The monitor skips warm/batch children whose image cannot be proven from their command line.
Do not enable a warm worker without implementing an equally unambiguous view binding.

Network requests have a two-second timeout, no redirects, retries or backlog. Only the
monitor waits for them. The renderer and dispatcher never await this observer. Progress
disappears when unavailable or stale; no elapsed-time interpolation invents finer progress.
Existing Cycles log cadence determines how granular the measured updates can be.

## Compatible rollout

1. Apply `202610200008_render_samples.sql`. It adds a private telemetry table and two
   service-role-only RPCs. Existing snapshot/event contracts, worker registrations, pixel
   recipes, artifact rows, event sequencing, journals and queue ownership are unchanged.
2. Run the monitor on the Vast host as a separate process, with a root-only environment
   containing the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Never copy that
   environment into a renderer sandbox or a browser.

   ```sh
   flock -n /run/fury-sample-monitor.lock \
     python3 /opt/fury/performance/render-sample-monitor.py \
       --publish --env-file /etc/fury/dispatcher.env --output /run/fury-sample-progress.json
   ```

   `--once` prints observations and exits without network access. Omitting `--publish`
   leaves the database untouched and supports an SSH/read-only operator dashboard.
   Output is atomically replaced with mode 0600; use a root-owned output directory.
   `--env-file` reads only the two Supabase variables from an existing owner-only file,
   not Vercel or dispatcher credentials. It evaluates no shell code.

3. Deploy the configurator/API change. The new signed-session GET endpoint is
   `/api/render-library/jobs/{jobId}/samples`. Existing clients and workers remain valid.
   The database only exposes samples for a current rendering camera, matching
   attempt/fence/image, younger than 15 seconds, and a session that joined that job.
4. No GPU worker rebuild, re-registration, restart, queue pause or extra test render is needed.
   Stop just the monitor to disable telemetry; rendering continues.

## Validation

```sh
python3 -m unittest discover -s scripts -p test_render_sample_monitor.py
npx vitest run src/prototype/useSampleProgress.test.ts src/prototype/LibrarySetStatus.test.tsx \
  src/render-library/server/tests/server.test.ts src/render-library/server/tests/api-runtime.test.ts
RENDER_LIBRARY_TEST_CONTAINER=<isolated-postgres-container> \
  npx vitest run src/render-library/server/tests/postgres.test.ts
npm run lint
npm run typecheck
npm run build
```

The local SQL tests cover attempt/fence/image checks, monotonic observations, stale data,
session isolation, RLS, and unchanged accounting, job state and durable event sequence.
CPU polling cost can be measured with repeated `observe()` calls during existing renders;
no duplicate paid render is required for that measurement.
