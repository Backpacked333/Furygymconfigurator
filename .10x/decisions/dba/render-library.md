# Render library schema [DISCOVERED 2026-10-20]

The schema is Supabase Postgres, defined in `supabase/migrations/2026101900{01,02,03,04,05}` and `2026102000{01..05}`.

## Tables

- **Core tables (`…190001`):** `render_library_` recipes, approvals, sets, images, sessions, jobs, job_images, reservations, outbox, events, idempotency and artifact_intents.
- **One active job per set.** A partial unique index allows only one active job per set.

## Key functions

All business logic sits in security-definer RPCs that only `service_role` can execute. RLS is on, and grants are revoked from anon and authenticated.

| Function                          | Role                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `render_library_reserve_internal` | Admission: idempotency replay, approval/budget, rate limits, join an existing job, outbox. Runs under advisory lock 73941020261019 |
| `render_library_claim_dispatch`   | Lanes: at most 2 claims globally and 1 per lane. Foreground goes to the latest request first; background is FIFO                   |
| `render_library_claim_worker`     | Once per outbox row: fence+1, deadline 2280 s                                                                                      |
| `render_library_publish_asset`    | Writes the published descriptor                                                                                                    |

## Other additions

- **`render_library_worker_builds`** is append-only, enforced by an immutability trigger.
- **Dispatcher cycle charging** takes 250000 µUSD up front and refunds the unused part afterwards. When the budget is exhausted, the dispatcher halts.

## Storage buckets

| Bucket                   | Access  | Limits           |
| ------------------------ | ------- | ---------------- |
| `render-library`         | Public  | WebP only, 8 MiB |
| `render-library-staging` | Private | —                |

## Notes

- There is no TTL reclaim of claimed dispatches; recovery is handled by the journal and reconcile paths in `on_demand/dispatcher.py`.
- Migrations are applied manually by an operator. CI tests them against a Postgres 16 service.
