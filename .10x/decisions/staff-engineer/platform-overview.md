# Conventions [DISCOVERED 2026-10-20]

## Schemas and data

- **Parsing.** Every schema is Zod 4 `.strict()`, with `superRefine` for cross-field rules and discriminated unions. Inputs arrive as `unknown`, are parsed at each boundary, and the result is deep-frozen.
- **Identifiers.** Catalog ids are versioned (`…-draft@1`), as are storage keys (`fury-*-v1`).
- **Storage writes.** Storage uses compare-and-swap, archives the old value before replacing it, verifies after writing, and fails closed.

## Structure

- **Container/view split.** `*View.tsx` files are free of persistence and renderer code.
- **Import boundaries.** These are enforced by `*.boundary.test.ts`, which parses imports with the TypeScript compiler API, and by `scripts/*-boundaries.test.ts`, which checks the client chunks.
- **Render state outside React.** Render-side status lives in module stores read through `useSyncExternalStore` (`stillStatus`, `traceStatus`, `progress`, `liveView`), not in React state.

## Tests and tooling

- **Tests.** Vitest, co-located, with jsdom plus `createRoot`/`act` and no Testing Library. GPU code is tested through mocks only; README states that pixels are not proven.
- **Comments.** Comment density is high and prose-style: comments explain _why_, and long JSDoc blocks state the policy ("not an approval").
- **Commands.** `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`. Prettier config is in `.prettierrc.json`.
- **Patches.** `patch-package` applies a patch to three-gpu-pathtracer (see `patches/`).
