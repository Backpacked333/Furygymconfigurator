# Security review: live 360° speed and quality (PR #38)

**Scope.** Client-only rendering changes on the library route. There are no server, API, database
or auth changes, and nothing changes under `api/`, `supabase/`, `src/render-library/server` or
`render-server/`.

## Assessment

| Area                 | Finding                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New network requests | Scan prefetch (`src/render/scanFiles.ts`) fetches same-origin `public/textures/*` WebP URLs built from the static `TEXTURE_SETS` table. It never uses user input in a URL, honours `saveData`, and uses low priority. |
| URL parameters       | `?arc=`, `?traceScale=`. Both are parsed with strict numeric bounds (`[30,360)` and `[0.5,1]`); anything else is ignored. Neither reaches the DOM or the network.                                                     |
| Third-party code     | `patches/three-gpu-pathtracer+0.0.27.patch` adds a cache of a pure struct length. Packed GPU buffers are byte-identical, which a test asserts, and patch-package fails the install if the patch doesn't apply.        |
| Private builds       | `scanFiles.ts` passes the display and capture module allow-lists, guarded by tests. There is no new eager import into gallery JS; the boundary tests are extended.                                                    |
| Paid rendering       | Unchanged. The 360° view still never starts a cloud or paid render, and the copy says so.                                                                                                                             |
| Memory and DoS       | Decoded scans are kept only while the tracer lives (same as legacy). History is capped at 128 MiB. The prefetch map holds encoded blobs only.                                                                         |

**Verdict:** no security concerns. No secrets are added or touched.
