# SDE decisions

| Feature                                                            | Status                                          | Record                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------ |
| Photoreal rendering (path-traced stills, then real-time uplift)    | Stage 1 done; stage 2 in progress               | [photoreal-rendering.md](photoreal-rendering.md)       |
| Path tracing speed (prompt start, sample reuse across views)       | Implemented                                     | [trace-speed.md](trace-speed.md)                       |
| Cloud rendering (Blender Cycles on a Modal GPU, hybrid with local) | Implemented; GPU timings pending deploy         | [cloud-render.md](cloud-render.md)                     |
| Live 360° viewer (library route, progressive local refine)         | [DISCOVERED] shipped in PR #30; F1 fixed in #38 | [live-360-viewer.md](live-360-viewer.md)               |
| Live 360° speed and quality                                        | Phase 1 built (b97f317)                         | [live-360-speed-quality.md](live-360-speed-quality.md) |
