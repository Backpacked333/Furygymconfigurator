# Platform architecture [DISCOVERED 2026-10-20]

## Client

- **Routing.** `main.tsx` routes on the query string; there is no router. Both experiences are lazy-imported, so neither pays for the other.
- **Shared views.** The `*View.tsx` presentational components (`ConfigPanelView`, `StageToolbarView`, `SpecificationView`, `StagePresentation`) are reused by both experiences.
- **Projection.** v4 is projected to v3 `Config` one-way (`projectDesignToConfig`) to feed the 3D scene.
- **3D scene.** The scene is fully procedural:
  - `render/architecture.ts`, `equipment.ts`, `scenery.ts`, `addons.ts` and `openings.ts` build the geometry;
  - `parts.ts` `batch()` merges parts by material;
  - Poly Haven CC0 scans supply textures, as `public/textures/<set>/{albedo,normal,arm}.webp`.
- **Raster pipeline (`render/pipeline.ts`).** Each quality tier adds passes:

  | Tier  | Passes                                                      |
  | ----- | ----------------------------------------------------------- |
  | Lite  | 4× MSAA only                                                |
  | High  | adds GTAO, sun contact shadows, TRAA, bloom and motion blur |
  | Ultra | adds SSGI and SSR on metals                                 |

  Every tier finishes with AgX tone mapping.

- **Path tracing (`render/pathtrace.ts` `PathTraceSession`).**
  - Milestones are denoised by OIDN (guided by albedo and normal) and crossfaded in.
  - Adaptive tiles retire regions that have settled.
  - Sample history is reprojected between views (`history.ts`).

## Server (library route)

1. **Lookup.** `POST /api/render-library/lookup` is read-only. It reads a Postgres snapshot and fills gaps from the pinned seed manifest (400 images, SHA-pinned).
2. **Request.** `POST /jobs` requires a session cookie plus CSRF. It runs one security-definer RPC (`render_library_reserve_internal`) under an advisory lock, which handles:
   - idempotency;
   - the approval and budget ledger;
   - rate limits;
   - one active job per set;
   - writing the outbox row.
3. **Dispatch.** The Modal dispatcher has foreground and background lanes, at most 2 claims globally and 1 per lane.
   - It fences each build by `workerBuildSha256`.
   - It prepares the scene on CPU (`scripts/native-render-prepare.ts`).
   - It sends the job to the GPU worker over SSH (Vast) or as a Modal Sandbox.
4. **Upload.** The worker uploads to the private staging bucket through a signed URL.
5. **Publish.** The server verifies the pixels (sha, WebP and full decode), then copies the image to the public bucket with put-if-absent.

## Identity

- **Image keys.** `set_<sha256>` and `img_<sha256>` are computed over canonical JSON of the design plus `recipeRelease` (`fury-native-five@2`).
- **Seed entries.** Each seed entry's `requestKey` is sha256(serializeDesign(design)).
