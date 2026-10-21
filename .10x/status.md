# Status

## Photoreal rendering (SDE)

- [x] Path tracer integrated on the app's WebGPU renderer (rest detection, re-capture fingerprint)
- [x] Shared sky calibration; CPU equirect sky with ported SkyMesh clouds; sun as 0.53° disc light
- [x] Path-trace stand-ins for TSL materials (foliage, grass, palms, ground, mirror), thin glass
- [x] Denoised milestones (OIDN, albedo/normal guided) with crossfades; raw fallback
- [x] Photo and PDF exports wait for a denoised ≥384 spp image (45 s cap)
- [x] Status badge, Surroundings toggle, `?trace` / `?denoise` parameters
- [x] Offscreen-harness verification: Courtyard pod exterior (noon and dusk) and interior traced,
      denoised, exposure-matched, converged
- [x] Stage 2 (part): 2K scans for close/large surfaces; sun shadows from surroundings
- [x] Stage 2 (part): sun contact shadows on High and Ultra (`SSSNode`, distance-faded)
- [x] Stage 2 (part): site radiance probe for glazing and shell; SSR for metals on Ultra
- [x] Interior asset brief upgraded: per-asset realism specs, wear layer, material calibration,
      acceptance tests (same artifact link)
- [ ] Stage 2 (next): denser lawns/planting, facade detail, depth of field, the client's GLB
      assets per the interior asset brief
- [ ] Real-GPU check of the live canvas crossfade and time to first denoised image (Vercel preview)
- [x] Tracing starts promptly after an orbit (glide tail ended; 6 still frames + 150 ms)
- [x] Camera moves keep samples: new views are seeded from the last traced view (reprojection)
- [ ] Real-GPU timing of seeded vs. fresh views; decide on off-device rendering (user's call)

Draft PR: Backpacked333/Furygymconfigurator#9 (branch `claude/configurator-design-impl-2a8tt0`).
