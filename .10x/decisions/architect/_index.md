# Principal Architect — Index

## Cross-cutting principles

- [DISCOVERED] One validated, versioned `Config` (Zod, schema v2) is the single source of truth for scene, floor plan,
  quote checklist, share URL, saved builds, and PDF. `src/lib/config.ts` owns rules; `src/lib/products.ts` owns facts.
- [DISCOVERED] Layering: `lib/` (pure domain) → `render/` (pure part-list builders, no React) → `components/` (R3F/React).
- [DISCOVERED] Versioned migrations in `configSchema` preprocess (v1 → v2). Invalid shared configs are rejected.

## Active features

| Slug                      | Status        | File                         |
| ------------------------- | ------------- | ---------------------------- |
| multi-unit-configurations | Brainstorming | multi-unit-configurations.md |
