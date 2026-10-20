# Live 360° speed and quality: delivery

## Deploy

The web app deploys through the Vercel Git integration once the PR merges. There are:

- no migrations;
- no environment variables;
- no changes to the dispatcher or worker.

`postinstall` runs patch-package and fails loudly if the tracer patch doesn't apply.

## Rollback

- **Before merge:** the whole change is one PR (#38). Not merging it leaves main-branch exactly as it is.
- **After merge:** `git revert -m 1 <merge commit>` removes it in one step. No data or schema depends on it.

## Feature flags

Two URL flags, both off by default:

- `?arc=N`: the limited exterior orbit.
- `?traceScale=0.5–1`: trace scale for A/B testing.

Everything else is on for the library route only.

## Render version

`RENDER_VERSION` moves, because `src/render/**` changed. Baking is retired (`LEGACY_RENDER_DISABLED`)
and the baked-stills manifest was already stale, so nothing visible changes. The native-library images
and their identities do not depend on it.

## Branch note

`origin/main` is ahead of `main-branch` (PRs 35–42, backend only). This branch merges cleanly into both.
