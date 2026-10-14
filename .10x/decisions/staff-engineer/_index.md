# Staff Engineer — Index

## [DISCOVERED] Conventions

- Units are **feet** internally; x = unit length, z = depth, +z = front; y up. FLOOR_Y = 0.96.
- Geometry is procedural, batched per material (`render/parts.ts`), UVs in feet for true texture scale.
- No three.js imports in `render/quality.ts`, `render/progress.ts`, `lib/*` (keeps tests and app shell light).
- Prettier (`.prettierrc.json`), ESLint flat config, strict TS. Comment density is low; comments explain _why_.
- Tests co-located (`*.test.ts[x]`), Vitest + jsdom. Model tests assert geometry stays inside nominal envelopes.
- Honest copy: concept vs. published facts are always distinguished in UI, PDF, and README.

## Active features

| Slug                      | Status        | File |
| ------------------------- | ------------- | ---- |
| multi-unit-configurations | Brainstorming | —    |
