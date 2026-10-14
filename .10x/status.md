# Status

## Photoreal rendering (SDE)

- [x] Path tracer integrated on the app's WebGPU renderer (rest detection, re-capture fingerprint)
- [x] Shared sky calibration; CPU equirect sky with ported SkyMesh clouds; sun as 0.53° disc light
- [x] Path-trace stand-ins for TSL materials (foliage, grass, palms, ground, mirror), thin glass
- [x] Denoised milestones (OIDN, albedo/normal guided) with crossfades; raw fallback
- [x] Photo and PDF exports wait for a denoised ≥384 spp image (45 s cap)
- [x] Status badge, Surroundings toggle, `?trace` / `?denoise` parameters
- [ ] Offscreen-harness verification of traced images across the five signature builds
- [ ] Stage 2: real-time realism uplift (higher-resolution scans, DOF, vegetation, facades)

Draft PR: Backpacked333/Furygymconfigurator#9 (branch `claude/configurator-design-impl-2a8tt0`).
