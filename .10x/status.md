# Status

**Phase: Discovery Complete** (2026-10-20, main-branch @ 0d813f1). Awaiting user confirmation of findings.

## Discovery (this session)

- [x] Mapped both experiences: v3 legacy at `/` and v4 image-first library at `?experience=library`
- [x] Mapped the client render stack: procedural scene, raster tiers, path tracer, history reuse
- [x] Mapped the backend render library: Vercel API, Supabase RPCs, Modal dispatcher, Vast/Modal GPU worker
- [x] Deep-dived the live 360° viewer (`decisions/architect/live-360-viewer.md`)
- [x] Baseline on main-branch: typecheck OK, lint OK. vitest: 2449 passed, 1 failed, 35 skipped.
  - The failing test is `image-service/control-plane/objects.test.ts` "fails closed on denied filesystem reads…".
  - The container runs as root, which bypasses chmod, so this is environment-specific.
- [x] QA finding F1 confirmed by probe: the 360° viewer never starts path tracing on Lite at 60 Hz
- [ ] User to confirm or correct the discovered decisions; decide whether to fix F1 and F2

## Earlier work (photoreal rendering, v3 route)

These items are tracked in `decisions/sde/photoreal-rendering.md`, `trace-speed.md` and `cloud-render.md`. Draft PR Backpacked333/Furygymconfigurator#9 predates the library route.
