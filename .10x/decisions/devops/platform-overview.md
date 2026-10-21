# Build and deploy [DISCOVERED 2026-10-20]

## CI (`.github/workflows/ci.yml`)

- **verify job:** format check, lint, typecheck, then vitest (with a Postgres 16 service), then build. The `dist` folder is uploaded.
- **render-server job:** Python 3.11, pytest plus the `on_demand/tests` unittest suite.

## Deploy

| Part                    | How it deploys                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Web app                 | Vercel Git integration. Node functions in `api/**`: 60 s, 1024 MB. Immutable caching for `/native-library/*.webp`, `/assets`, `/stills` |
| Dispatcher              | `modal deploy render-server/deploy_dispatcher.py`, run manually                                                                         |
| Vast worker             | `setup_vast_worker.py` (verifies the immutable release in `/opt/fury/releases/<build>`)                                                 |
| Worker builds           | Content-hashed by `scripts/native-render-package.py`                                                                                    |
| Migrations and approval | Manual operator steps (`docs/render-library-service.md`)                                                                                |

There is no deploy workflow.

## Environment variables (names only)

- **Vercel:**
  - `RENDER_LIBRARY_PUBLIC_ORIGIN`
  - `RENDER_LIBRARY_SUPABASE_URL`
  - `RENDER_LIBRARY_SERVICE_ROLE_KEY`
  - `RENDER_LIBRARY_SESSION_SECRET`
  - `RENDER_LIBRARY_WORKER_TOKEN`
  - `RENDER_LIBRARY_APPROVAL_ID`
  - `RENDER_LIBRARY_ENABLED`
  - `RENDER_LIBRARY_DISPATCH_MODE`
  - `RENDER_LIBRARY_ALLOW_SEED_IMPORT`
  - `VITE_RENDER_LIBRARY_STORAGE_ORIGIN`
- **Dispatcher:** Modal secrets `fury-render-library-dispatcher` and `fury-render-library-vast-worker`. Variables are listed in `deploy_dispatcher.py`.

## Local tooling

Node is pinned to 24 in `.nvmrc`. The cloud container has Node 22, and every check passes on it.
