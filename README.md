# FURY / Container Gyms + S-Series Studios

A laptop-first configurator built for [Fury Co Gyms](https://www.furycogyms.com/), designed around 12–16-inch displays (roughly 1280–1728 CSS pixels wide). Explore separate Container Gym and S-Series Studio families, start from five signature builds recreated from Fury's portfolio, choose published and portfolio options, arrange generic equipment in a collision-aware floor plan, and take away a shareable concept design and PDF inquiry brief. Mobile has a basic responsive fallback but is not the primary experience.

**This is a working concept configurator, not a live purchasing system.** Published family starting prices are source-backed, but every selected build requires a quote. Geometry is not manufacturer CAD; finish palettes, floor looks, equipment, and working clearances are generic visual studies. No customer details, payments, or sales emails are sent anywhere. The official inquiry link opens Fury's website without transferring this configuration.

## Rendered configuration library

Open **`/?experience=library`** to use the image-first configurator with real, exact-matching Blender/Cycles renders. This explicit route works in development and production builds; the ordinary `/` route retains the existing v3 experience.

- **Rendered builds** opens the visual catalog, filtered by collection and size. Choosing a build loads its complete configuration as one undoable change.
- The library contains **50 configurations / 400 images**: seven Studio Day cameras and one Studio Night front-three-quarter view for each build. The checked-in manifest is the source of truth for completed coverage.
- Customers see exactly **five views** (four exterior and one entry interior), four scenes, and Day/Night. New designs start in Studio Day; restored scene/lighting choices remain intact. Historical extra cameras and all image/receipt bytes remain preserved; saved legacy cameras normalize only at the customer boundary.
- Both Studio and Container families include 20 ft and 40 ft sizes, all seven finishes, and selected floor/interior combinations. Equipment arrangements are fixed.
- Changing a control updates the design immediately. The client only displays an image when the entire canonical design matches, then verifies its SHA-256, decoded dimensions and format boundary. It never substitutes a finish-only or previous-design image.
- Images are 1920×1200 WebP, encoded at quality 95 from 1,024-sample native GPU renders. Small gallery/camera thumbnails are separately derived. Hashed assets receive immutable CDN caching; the manifest revalidates. The client retains at most eight decoded-image URLs.
- **Rendering is disabled until separately activated.** With an approved, configured service, only **Bring your vision to life** requests missing views for the exact design. Browsing, refresh and status checks never render. Partial results arrive individually with real job stages and a completed-view count; ambiguous delivery never auto-retries. When the service is unavailable, the static library remains browsable and lookup errors are not presented as confirmed cache misses.

The [durable service](docs/render-library-service.md) and [private native worker](render-server/on_demand/README.md) implement the [render-library contract](docs/render-library-contract.md). Postgres owns shared admission, budget reservations, job state and immutable image receipts; Storage owns verified WebP bytes. Server/worker modules are excluded from the library browser bundle. No migrations, provider activation, spend approval or production deployment are performed by installing this repository. Review both guides before activation; the previous experiment is not authorization for new jobs.

These are draft design previews, **not** strict reference exports, engineering approval or final art-direction qualification. Console/signature lettering and material/lighting parity remain incomplete. Native render time is not cached-image delivery time. The batch does not activate the private on-demand services below or change production domains.

### Run and verify

Use Node 24 from `.nvmrc`, then `npm ci` and `npm run dev`. Open `/?experience=library`. No GPU credentials, Blender installation or backend are needed to browse the completed static library. Vite alone does not serve `/api/render-library/*`; see the service guide for the separate Node API configuration and deployment prerequisites.

```sh
npx vitest run src/render-library src/prototype
npm run format:check
npm run typecheck
npm run lint
npm run build
```

`VITE_RENDER_LIBRARY_STORAGE_ORIGIN` is the only public library setting: the exact HTTPS Supabase origin allowed for completed dynamic images. All `RENDER_LIBRARY_*` keys are server-only and documented in the service guide. Never use a `VITE_` prefix for service-role keys, session secrets, worker tokens or approval settings.

The runtime manifest is `public/native-library/manifest.json`; full-resolution image filenames are their content SHA-256. A missing exact entry is a coverage gap, not permission to dispatch a render or reuse a different image.

### Fixed-layout foundation (local, not activated)

The [P01 foundation](docs/fixed-layout-foundation.md) adds strict draft-aware fixed-arrangement contracts, deterministic layout identity and lossless raw-recovery helpers. The four proposed arrangements remain unapproved and production use is denied by the new contract gate. The customer UI still uses v3 and has not switched to fixed layouts. Provisional full product/presentation v4 is available only in the DEV image path described below; legacy copy conversion is not implemented. Malformed saved libraries are now archived and verified before replacement, rather than silently discarded. No paid rendering or deployment is authorized by this work.

The [development-only review workspace](docs/fixed-layout-review.md) at `/review.html` exercises those proposals with a read-only SVG plan, fixed family/size commands, Undo/Redo, explicit local save, local review links, JSON export and raw-data recovery. It has a separate storage namespace and no renderer dependency. The normal customer entry is unchanged, and the review page is excluded from the normal production build. See the linked guide for limitations and local verification commands.

### P03 private rendering preparation (local, non-dispatchable)

[P03](docs/p03-private-preparation.md) now prepares the full configuration-only private Three recipe, CPU geometry/material/camera receipts, pinned asset validation and actual private bundle closure. It produces six fixtures, 14 compositions / 28 case-specific scenes and a strict 1,024-sample reference manifest in an exclusively written, replay-verifiable directory. This is not customer-browser scene construction or a render operation. [Rights evidence remains held](docs/p03-asset-rights.md); fonts, reference conversion, art qualification and execution authorization remain separate gates. The default v3 route, B-based image UI and original real-image capture history are preserved. See the P03 guide for Node 24 setup, exact `NODE_ENV=production` preparation/verification commands and the 45-file output contract.

### P04 safe image control plane (local diagnostic only)

[P04](docs/p04-safe-image-service.md) adds an isolated SQLite reservation ledger, immutable filesystem object boundary, authenticated loopback API, durable **fake-only** provider, fenced worker and independent watchdog. Its outputs are labelled diagnostic SVGs, not current design images or strict exports. Paid execution and production use remain disabled; no P04 route is mounted on the public frontend. The actual B image UI and default v3 entry are unchanged. The [provider decision](docs/p04-provider-decision.md) is a proposal, not approval or provisioning.

**Legacy cloud dispatch is retired in this local candidate.** Public builds cannot select or warm the old renderer; remote clients, gateway, deployment and bake entry points refuse work. The B UI, default local v3 path and saved images remain preserved. This does not stop any previously deployed host or qualify a real provider. See [retirement evidence and remaining gates](docs/p04-legacy-retirement.md).

### Private Cycles construction (local, no render)

The [construction adapter](docs/cycles-construction.md) now translates validated designs into actual Blender meshes, textured materials and a bound camera, with locked strict-reference settings. Six fixtures and portrait projection are checked without rendering. World/landscape/light conversion, font pixels, completed-sample evidence and quality approval remain outstanding. The new image-first scene controls use four landscapes with Day/Night only; legacy saved Neutral Studio designs remain readable. The default v3 interface and existing image files are unchanged.

## Official product sources

Reviewed **October 14, 2026**. `src/lib/products.ts` contains the source URLs, nominal heights, features, starting prices, and published option names. These are a dated snapshot, not a live pricing feed.

| Family                                                            | Nominal exterior sizes                     | Published family starting price | Published choices                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Container Gyms](https://www.furycogyms.com/gym-design/container) | 20′ or 40′ L × 8′ W × 9′6″ H; 160 / 320 SF | $20,000 USD                     | 10′ roll-up door; center, partial, full open-side; integrated exterior finish                                     |
| [S-Series Studios](https://www.furycogyms.com/gym-design/studio)  | 20′ or 40′ L × 8′ W × 10′ H; 160 / 320 SF  | $35,000 USD                     | Front deck, gazebo, rooftop deck, exterior stairs; connected, double-wide, multi-level, stacked, custom inquiries |

Fury does **not** publish separate 20′/40′ prices or a full option price list on these pages. Starting prices therefore never scale by length or become configured totals. `estimate()` returns `total: null` and `amount: null` for unpriced selections—not zero. There is no financing calculator based on an invented principal. The [project inquiry page](https://www.furycogyms.com/start-a-project) separately says smaller entry-level projects typically start at $25,000; this is different project guidance, not an extra fee added to the Container starting price.

### Portfolio reference designs

Five client-supplied photographs of built Fury units (reviewed **October 14, 2026**) define the portfolio options and the signature builds that reproduce them:

| Signature build     | Photographed build                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Courtyard pod       | Light S-Series pod, five black-framed bays, hinged door, functional trainer and air bike, apartments |
| Campus pod          | Dark S-Series pod, sliding door, oak floor, trainer, dumbbells, plyo box, med balls, office campus   |
| Clubhouse container | Bronze container, full-view glass overhead door, lit canopy, cedar interior, half racks, at dusk     |
| Garden Pilates      | Charcoal container, top-hung glass sashes propped open, timber deck, birch interior, reformer        |
| Rooftop container   | Black container, raised glass door, timber-clad roof deck, cable rail, black steel stair, power rack |

Options taken from these photographs (Studio hinged/sliding doors, Container glass overhead doors and awning sashes, Container decks, roof decks, stairs and entry canopy, cable railing) are labeled **“Seen in Fury builds”** or **Portfolio** in the app. They are concept interpretations of the photographs, not published specifications: none has a published price, all are quote-only, and geometry is illustrative.

Connected and stacked Studio requests are saved in the design and brief, but the scene and floor plan show **one reference unit**, not an engineered assembly. The website does not specify unit counts, connection geometry, loads, or permitted arrangements. Other door widths and colors are also inquiry-only. Performance flooring is published; the app's oak/stone looks, timber accent, named colors, mirror wall, and equipment presets are not an approved Fury catalog.

## Run locally

Requirements: **Node.js 24 LTS** and npm. The runtime version is declared in `.nvmrc`; dependencies are locked in `package-lock.json`.

```sh
nvm install
nvm use
npm ci
npm run dev
```

Open the URL printed by Vite. If you do not use nvm, install Node 24 and run the npm commands directly. No environment variables, API keys, database, or third-party accounts are required. Fonts, models, textures, and scripts are bundled or generated locally; there are no remote model, texture, or font requests at runtime. The old cloud renderer is retired: `VITE_CLOUD_RENDER_URL` cannot enable it in production, and remote URLs are refused in development too. Private P04 diagnostics remain separate from the public app.

Optional URL parameters help when comparing devices or debugging: `?renderer=webgl` forces the WebGL 2 backend, `?quality=ultra|high|lite` fixes the render tier (and disables the automatic step-down), `?trace=1|0` turns path-traced stills on or off, `?cloud=0` keeps tracing on this device even when a cloud renderer is configured, `?cloud=http://127.0.0.1:8787` uses a local render server, `?denoise=0` shows the raw path-traced accumulation, `?bench=1` shows a small table of rendering timings over the scene (when the live view, the first path-traced preview and the first good frame appeared, how the cloud answered and what its frames cost, the local tracer's times; `docs/benchmarks.md` lists the fields), and `?debug=ao`, `?debug=normal`, `?debug=contact`, `?debug=reflections`, or `?debug=motion` shows the ambient-occlusion, normal, contact-shadow, screen-space reflection, or velocity buffer on High and Ultra (the velocity view is grey at rest, red for motion to the right and green for motion up, at full strength for a twentieth of the screen per frame).

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run preview
```

`npm run format` applies Prettier. CI runs formatting, ESLint, TypeScript, Vitest, and the production build. There are no custom pre-commit hooks. Production output is `dist/`, suitable for Vercel, Netlify, Cloudflare Pages, or another static host. Configure `npm run build` as the build command and `dist` as the output directory; serve the app over HTTPS for clipboard sharing and WebGPU (browsers only expose WebGPU to secure contexts). Do not expose Vite's development server as the public production service.

The project deploys on Vercel. `vercel.json` caches Vite's content-hashed `/assets/*` for a year and the bundled `/textures/*` for a day with background revalidation, since texture filenames are not hashed. If you regenerate a texture set, returning visitors may see the previous version for up to a day.

## Isolated private display candidate (unqualified; no execution permission)

The private on-demand display experiment is separate from the completed static library above. It remains unqualified and disabled by default. Its tests use labelled doubles; they do not establish GPU image quality or delivery latency. Strict Cycles exports and the earlier local capture ledger remain separate.

The following render-free commands belong to the original isolated operator environment, not the normal frontend setup. Their output/provision paths are intentionally fixed by that experiment; browsing the static library requires none of them:

```sh
node scripts/display-renderer-verify.ts --verify-only --output /home/ubuntu/Documents/fury-display-handoff/renderer-operator-check.json
node scripts/display-service-verify.ts --verify-only --output /home/ubuntu/Documents/fury-display-handoff/service-verify-operator-check.json
node scripts/display-operator.ts --preflight
```

The first two compile/prepare without reading permission or opening a renderer. Preflight also reads, but never creates or changes, the operator provision and run journals, checks for accessible GPU device nodes, and reports execution holds. Device-node availability is not hardware/visual qualification. All builds must succeed; all runtime adapter, shader, readiness, checksum/decode, ownership and lifetime checks still apply later. The private entry and site-field worker are separately bundled in memory; a customer-build guard rejects private execution modules, and private source paths are denied even on a disabled/production-mode development server.

**Future execution only after separate explicit operator approval:** `node scripts/display-operator.ts --serve` runs preflight before binding a strict loopback Vite server on port 5173. It sets only the two private DEV flags, not production/provider bypasses. It cannot dispatch without the single pre-existing private authority at `/home/ubuntu/Documents/fury-display-handoff/private-display-operator/operator.json` (owner-only directory 0700, regular owner-only file 0600, no symlinks/hardlinks). The strict schema is `displayOperatorSchema` in `src/display/operator.ts`; it contains an existing owner/credential and an `operator-local-only` permit with finite expiry/jobs/bytes and paid/production flags fixed false. No provisioning, credential-printing, reset, budget-extension or arbitrary executable/endpoint command is supplied. Do not create permission as part of verification or delete run locks/journals to bypass a hold.

After authorized startup, exchange the already-provisioned credential on the **same loopback origin** with `POST /__fury-display/v1/session`, `Authorization: Bearer <existing credential>`, JSON `{ "protocol": "fury.private-display@1" }` and the same-origin `Origin` header. This endpoint creates no interest/job; it returns an HttpOnly/SameSite=Strict cookie, not execution authorization. Do not put credentials in URLs, local storage, screenshots or logs. Then select `?prototype=images&imageMode=private-display` in that browser context. The mode is explicitly DEV-only; default v3 is not changed. Pending submission/status responses are 202, ready is 200; cancelling detaches only that interest. One owner cancelling does not cancel another interest in shared work.

Selection changes acknowledge immediately but do not cancel an active render. The client retains one bounded in-flight request and only the latest not-yet-submitted selection; obsolete completions never become current. Once the active request settles, its image URL/interest is released and the latest selection is submitted normally (including exact-cache lookup). Intermediate selections are not rendered. This conservative policy can delay even a cached selection behind active work; GPU latency is not qualified. Leaving the mode still cancels its interest, and last-interest active cancellation, timeout or failure still poisons the session rather than reopening it or resetting its allowance.

One session, one mutation/encode, four queued keys, 32 interests, 24 attempted jobs, 180 seconds/job, 600 seconds total and 30 seconds idle are hard ceilings, not SLA promises. PNG/output/cache bounds remain enforced. A ready image does **not** prove worker shutdown or final billing: `hostShutdownProven` and `billingFinal` stay false. Unknown teardown quarantines the durable run. Synthetic lifecycle tests and source builds cannot establish real GPU A→B→A image correctness, latency, visual quality, device-loss cleanup or host/process-tree exit on this machine. Those require a later bounded, separately authorized review; do not run it here.

## What works

| Area          | Implemented                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products      | Two families, 20-/40-foot footprints, family-specific nominal heights and source-linked features; five signature builds with matching camera angles                     |
| Exterior      | Studio hinged or sliding door; Container openings with open side, glass overhead door, or awning sashes, each shown open or closed; integrated finish; seven colors     |
| Additions     | Studio front deck and gazebo; Container grade deck and entry canopy with downlights; roof deck with glass or cable rail and exterior stair for both families            |
| Visualization | Gallery of path-traced stills at nine angles; 360° View (exterior orbit, interior look-around) with motion blur; WebGPU with WebGL 2 fallback; six settings, lights     |
| Rendering     | Ultra (screen-space GI), High (GTAO, bloom, temporal AA), Lite (MSAA); interior radiance probe, planar mirror, area-light washes, automatic quality step-down           |
| Interior      | Gallery, oak-slat, cedar, and birch-ply finishes; four floors; strength, recovery, movement, cardio, and empty presets; sixteen generic equipment items                 |
| Floor plan    | Pointer dragging, quarter-foot snapping, rotation, removal, entry and boundary protection, collision rejection, visible working-space envelopes                         |
| Decisions     | Published family starting prices, unpriced quote checklist, custom Studio inquiry request, 50-step undo/redo, signature portfolio builds                                |
| Persistence   | Automatic local draft, up to 12 named local builds, two-build comparison, versioned compressed share URLs                                                               |
| Deliverables  | Configuration JSON, current-view PNG, multipage PDF with scene image when available, floor plan, sourced starting price, quote checklist, notes, and share link         |
| Access        | Responsive controls, touch interaction, keyboard camera and floor-plan controls, labeled options, focus-trapped dialogs, reduced-motion camera transitions, 2D fallback |

### Controls

The stage shows the design like a car configurator: the title, the view switch (Exterior, Interior, Floor plan), undo/redo, and the status line sit above the picture; the filmstrip of nine angles sits under it; and one glass toolbar sits over the picture's bottom edge. Nothing else is drawn on the picture.

- **Gallery:** the stage shows a path-traced still of the angle picked in the filmstrip (six outside, three in the room). See [Path-traced stills](#path-traced-stills).
- **Toolbar:** _Adjust scene_ opens the setting and the time of day (and a link to every setting option); _360° View_ opens the live 3D view and, pressed again ("× 360° View"), closes it; _Download_ saves a PNG of the current angle (the full-quality export still when one can be rendered, which takes up to a minute in the cloud; the live frame in the 360° View); _Full screen_ shows the picture alone, toolbar included (where the browser allows it; not on iPhone). In the 360° View the toolbar adds _Dimensions_, _Reset view_, and _Auto-rotate_. On a narrow picture the toolbar keeps its icons and drops its words; every button keeps its accessible name.
- **360° View, outside:** drag to orbit, pinch or scroll to zoom. Focus the view for arrow keys and `+`/`−`.
- **360° View, inside:** drag or use arrows to look around from where the interior angle stands. This is not a collision-enabled walk-through.
- **Floor plan:** drag an item; arrows move it 3 inches, Shift+arrows move it 1 foot, `R` rotates, Delete/Backspace removes. Invalid moves are rejected with an explanation. Rotation is 0° or 90°.
- **History:** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes. Changing size preserves selections, and downsizing is blocked if current equipment would no longer fit.

## Configuration architecture

One validated, versioned `Config` object drives the scene, layout, quote checklist, share payload, and PDF. `src/lib/config.ts` owns the Zod schema, planning equipment, presets, validation rules, unit conversions, and quote semantics. `src/lib/products.ts` owns the sourced product facts. Never add prices separately in a component or PDF.

```text
src/
  App.tsx                     Workspace, dialogs, camera modes, history shortcuts, quality governor
  components/
    ConfigPanel.tsx           Four-step selection interface and signature builds
    Elevation.tsx             Front-elevation drawing of any configuration (cards, dialogs)
    Scene.tsx                 Async WebGPU canvas, camera, dimensions, graphics fallback
    RenderEffects.tsx         Drives the TSL pipeline, settle frames, captures, frame-time governor
    Atmosphere.tsx            Physical sky, fog, image-based lighting, sun and moon, exposure
    InteriorProbe.tsx         Radiance probe captured inside the room for interior surfaces
    InteriorLights.tsx        Downlights, cove and toe-kick area lights, fixtures
    StudioModel.tsx           Shell, interior, glazing, add-ons, signature, mirror, equipment
    Equipment.tsx             Batched equipment models shared by every placed copy
    Landscape.tsx             Anti-tiled ground, hardscape, trees, hedge, grasses, desert plants
    Surroundings.tsx          Residential courtyard, corporate campus, and backyard settings
    Mirror.tsx                The mirror's pane, of the glass render/mirror.ts makes
    Parts.tsx                 Renders a part list as merged, per-material meshes
    FloorPlan.tsx             Accessible SVG floor-plan editor
    Dialogs.tsx               Saved comparisons, quote checklist, sharing, brief form
    Modal.tsx                 Native dialog lifecycle
  render/
    renderer.ts               WebGPURenderer creation, area-light tables, texture-view shim
    pipeline.ts               TSL render pipelines per quality tier, traced-image presentation
    pathtrace.ts              Path-traced stills: scene capture, sun disc, sky map, denoising
    history.ts                Sample reuse between views: G-buffer, reprojection kernel
    cloud.ts                  Cloud renderer client: scene capture, blob uploads, frames
    spin.ts                   Path-traced spin and interior panorama from the cloud renderer
    plan.ts                   The spin's order of work: coverage first, longer renders admitted
    bench.ts                  Rendering timings for ?bench=1 (no three.js imports)
    adaptive.ts               Adaptive sampling: retire regions whose denoised image has settled
    motion.ts                 Camera rest: on-screen motion, ending an orbit's glide
    traceStatus.ts            Path-tracing progress store for the status line (no three.js)
    framing.ts                Camera framing for the exterior and interior views
    quality.ts                Tiers, backend selection, defaults (no three.js imports)
    materials.ts              Material library over the scanned texture sets
    ground.ts                 Anti-tiled scanned ground, one material with its scans bound in place
    mirror.ts                 Mirror glass: planar reflector (High/Ultra) or probe-lit metal (Lite)
    palette.ts                Named physically based materials (powder coat, vinyl, glass...)
    geometry.ts               Geometry helpers with UVs in feet, corrugation, tubes, lathes
    parts.ts                  Part lists and static batching
    architecture.ts           Studio and Container shells, interior finishes, glazing
    openings.ts               Studio doors, glass overhead door, awning sashes, roll-up shutter
    addons.ts                 Decks, pergola, roof deck, railings, stairs, canopy, timber accent
    buildings.ts              Apartment blocks, offices, modern house, site furniture
    scenery.ts                Landscape density tiers and plant/rock geometry
    equipment.ts              Sixteen equipment models at real-world dimensions
    vegetation.ts             Leaf atlas, trees, grass, fan palms, flowering shrubs
    progress.ts               Material streaming progress (no three.js imports)
    useResource.ts            StrictMode-safe GPU resource lifetime
  lib/
    config.ts                 Domain model, rules, estimates, URLs, persistence
    products.ts               Official product facts, sources, and published choices
    useConfig.ts              Reducer-backed history and automatic draft
    export.ts                 On-demand PDF generation and downloads
    visuals.ts                Sun path, Preetham sky model, sunlight color, horizon fog
scripts/
  build-textures.py           Fetches CC0 scans and bakes procedural detail maps
public/textures/              Bundled texture sets and sources.json (authors, sizes, roles)
```

Dimensions use **feet internally**, with x along unit length and z along depth; the front is positive z. Both families are 20/40 × 8 feet, with heights from the product table above. The floor plan uses a conservative concept usable envelope and reserves a planned entry aligned to the chosen opening or Studio door. The Studio glazing is divided into equal bays (five on 20 feet, eleven on 40); the hinged door takes the second bay from the end and the sliding door the center bay. Only the roll-up width is published; other opening widths/positions and all deck/gazebo/stair geometry are illustrative. Collision checks cover equipment footprints and a small placement buffer, **not manufacturer safety clearances, electrical requirements, accessibility, structural loading, or permitted occupancy**. Dashed envelopes are illustrative guidance and can overlap.

Rules:

- Additions can be selected individually or together. Decks, roof decks, and stairs apply to both families (the Container versions come from the portfolio photographs); the gazebo and timber accent are Studio-only; the entry canopy is Container-only. All combinations still require support/access/engineering review; the model is not certification.
- Opening infills (glass overhead door, awning sashes) apply to the center, partial, and full open-side openings; the roll-up opening carries its own door. “Show open” is a visualization state saved with the design.
- Switching to Containers clears Studio-only additions, timber accents, doors, and custom Studio requests while preserving decks, roof decks, stairs, shared finishes, length, and equipment. Switching to Studios clears Container openings, infills, and the canopy, and prefers the hinged door unless it would obstruct the current layout, in which case the centered sliding door is used. Undo restores the previous state. A change that obstructs the new planned entry is blocked until equipment is rearranged.
- Signature builds replace the whole design, including family and length, after confirmation; every option stays editable.
- Invalid, unsupported, oversized, duplicate-ID, or geometrically invalid shared configurations are rejected.
- Schema `v: 3` adds `studioDoor`, `openingInfill`, `doorsOpen`, `railing`, `interiorStyle`, and `addons.canopy` to v2's `family`, `containerOpening`, `integratedFinish`, and `studioLayout`. Legacy `v: 1` and `v: 2` links/drafts/saved builds migrate automatically and are fully revalidated: Studios get the centered sliding door (so their planned entry, and every saved layout, is unchanged) and the original oak-slat interior; Containers keep their opening shown open, as v2 rendered it. Existing selections are preserved; old conceptual prices are not. Unsupported versions are rejected. This is the implemented app contract, not a roadmap example.

### Local data and sharing

The URL fragment `#c=…` contains the entire LZ-string-compressed configuration. It follows edits within half a second (at once when the tab is hidden or closed), so dragging a slider does not rewrite browser history on every step, and it is not sent in HTTP requests to the static host. Pasting another design's link into an open tab loads it; Undo returns to the previous design. Anyone with the full link can read the configuration. There is no short-link service, authentication, cross-device account, or automatic social-preview image. A link needs a running deployment of this app; localhost and session-preview links are not permanent public links.

`fury-draft-v1` and `fury-builds-v1` remain the only localStorage keys to preserve existing drafts and saved builds; their payloads migrate to the current schema (v3). A valid URL configuration takes precedence over the draft. Storage failure does not prevent configuration or file export; named-save failures show a message. Clearing browser storage removes local drafts and saved builds, so export important designs.

PDF generation loads jsPDF only when needed. Scene capture is omitted in floor-plan mode or when graphics are unavailable; the floor-plan drawing and other brief sections still export. Core PDF fonts target Latin-script text. No analytics or session replay is installed.

### Rendering and performance

The scene renders with three.js r186's `WebGPURenderer`. It runs natively on WebGPU and falls back to its WebGL 2 backend automatically, so every material and post effect is written once in TSL (three's shading language) and works on both. React Three Fiber creates the renderer asynchronously. The renderer badge in the scene status line shows the active backend and tier.

| Tier  | Pipeline                                                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ultra | High plus screen-space global illumination (one diffuse bounce of on-screen light) and screen-space reflections on metals and coated facade glass                                                  |
| High  | Depth/normal/velocity pre-pass, GTAO applied only to ambient light, sun contact shadows, emissive bloom, temporal reprojection anti-aliasing, motion blur in the 360° View, 4096-pixel sun shadows |
| Lite  | One 4× MSAA pass, 2048-pixel sun shadows, probe-lit mirror                                                                                                                                         |

Laptop-width screens start on Ultra, tablets on High, and phones on Lite. If back-to-back frames stay slow, the app steps down one tier and says so, unless a tier was chosen explicitly. Rendering is on demand: after any change it keeps drawing for a short settle window (about 28–40 frames) so temporal anti-aliasing, AO, and GI converge into a clean still, then stops.

#### 360° View

The 360° View is the live raster at the device's tier (Ultra or High where it keeps up, with the usual step-down), never path traced: the stills' tracer and cloud requests stand down while it is open, and pick up again when it closes.

- **Opening:** the camera is put exactly where the still on the stage was rendered from (`galleryCamera` in `src/render/gallery.ts`, for that angle and the stage's shape; an interior angle opens the look-around at its pose). The still stays over the canvas while the live view draws and settles (its temporal anti-aliasing, AO, and GI converge), then lifts off it in a 300 ms crossfade, so the switch is a change of medium, not of picture. On a device too slow to settle within 2.5 s it lifts anyway.
- **Motion blur (High and Ultra):** while the camera moves, each frame is blurred along every pixel's own motion from the velocity pre-pass, as a film camera's 180° shutter records it: a streak half as long as the distance the pixel moved since the frame before (three's velocity is in normalized device coordinates, so it is halved and flipped in y to texture coordinates), sampled with 12 taps after temporal anti-aliasing, and capped at 3.5% of the screen so a flick does not show as separate copies. Once the camera rests, the blur lets go within 120 ms and is then exactly off, so the frame the view settles on is the unblurred frame pixel for pixel; the view keeps drawing until it is (`src/render/motionBlur.ts`, `src/render/pipeline.ts`). Lite has no velocity pass and no blur.
- **Closing:** the stage returns to the gallery angle nearest where the camera ended up: outside, the angle seen from most nearly the same direction around the build (azimuth and elevation, compared on the sphere around it); inside, the angle looking most nearly the same way. The live view's last frame is held over the stage as an image until that angle's still is there under it, under the rendering status when it has to be rendered first, then fades off it in 300 ms; neither a raster frame of another angle nor a lesser image shows between. A filmstrip angle picked in the 360° View closes it to that angle the same way.

#### Path-traced stills

With WebGPU, a view that holds still refines into a path-traced image: true multi-bounce light, soft sun and area-light shadows, glass and mirror reflections, and light through the glazing into the room. Orbiting, walking the interior, and every edit stay real-time; the moment the camera or design changes, the rasterizer takes the frame back. `src/render/pathtrace.ts` drives [`three-gpu-pathtracer`](https://github.com/gkjohnson/three-gpu-pathtracer)'s WebGPU tracer on the app's own renderer, so the scene and textures are shared rather than duplicated.

- **Starting promptly:** tracing starts about 150 ms after the view has held still for six frames, without waiting for the raster settle window, since the traced image replaces it. An orbit's damped glide used to keep the camera moving by fractions of a pixel for hundreds of frames (10–20 s) after a drag, and nothing could start until it ended. Once the glide is below 0.6 px a frame it now decays faster, and below 0.05 px it is stopped, a final step of under 0.2 px (`src/render/motion.ts`).
- **Moving the camera keeps the work done:** a new view does not start from zero samples. When tracing stops, the view's accumulation, per-pixel sample counts, and rasterized positions and normals are kept; the next view of the same scene is seeded from them by a compute pass that reprojects each pixel to the same surface point in the old view (`src/render/history.ts`). A pixel inherits old samples only where that point was visible (positions within about a pixel's footprint, normals agreeing), and only as far as its look does not depend on the viewpoint: none for glass, mirrors, metals, clear coats, and anything below roughness 0.2; most for rough dielectrics, tapering as the viewing angle turns, when zooming in magnifies the old image, and across shadow edges. What carries over is the light arriving at the surface (color divided by albedo), multiplied back by the new view's own rasterized albedo, so texture detail stays sharp instead of being resampled. Every pixel still takes at least a quarter of its 256 samples fresh, so edges and anything the estimate got wrong converge to the true image. The tracer skips pixels that already hold enough samples, so its time goes first to what the old view did not show. A seeded view is denoised at 2 samples, so after a small orbit the converged image is back almost at once instead of after a full re-render.
- **Finishing where the image has settled:** a view no longer gives every pixel the same 256 samples. Each time a new denoised image arrives (the milestones double the sample count), it is compared with the previous one in 16-pixel tiles; a tile whose image changed by less than 1% on average and nowhere by more than 15%, at two doublings in a row, has settled, and pixels whose tile and neighbouring tiles have settled stop taking samples (`src/render/adaptive.ts`). Open sky, walls, and lawns finish after a few dozen samples while glass, deep shadow, and foliage keep refining up to 256 (384 for an export). When a tracer slot draws a finished pixel it now looks a few queue entries further for one that still needs samples, instead of idling for the round (a small patch to `three-gpu-pathtracer`, applied by `patch-package` on install; see `patches/`).
- **Edits update the traced scene in place:** a fingerprint per kind of change decides what to rebuild. Meshes appearing, disappearing, or changing shape capture the scene again (BVH and kernels); moved objects refit the BVH, new finishes rewrite the material buffers, and light or time-of-day changes update lights and sky, all without recompiling the tracer's GPU kernels.
- **Capture:** the tracer reads plain PBR properties, so the scene is swapped into a traceable form only for the instant of capture: the raster sky dome and sun are hidden, TSL-only materials expose stand-ins through `material.userData.pathTrace` (foliage and blossom atlases, grass, palms, the scanned ground, the planar mirror as polished metal), unlit helpers hide, and volumetric glass becomes thin-walled glass tinted by its absorption. Captures are cached by a fingerprint of geometry, transforms, materials, and lights; a camera-only change re-traces without rebuilding.
- **Sun and sky:** the sun is a disc light at its true 0.53° angular size carrying the same irradiance as the raster sun, so shadows soften with distance and glossy surfaces show real glints. The sky is a 1024×512 HDR map computed on the CPU from a line-for-line port of three's `SkyMesh` (Preetham scattering and its cloud layer), so the traced sky matches the real-time one. Calibration lives in `src/lib/visuals.ts` and is shared by both renderers.
- **Denoising:** at 8, 16, 32, 64, 128, and 256 samples per pixel (from 2 on a seeded view), and at 384 for an export, the accumulation is denoised with [Open Image Denoise](https://www.openimagedenoise.org/) on the GPU (`oidn-web`, guided by rasterized albedo and normals) and crossfaded in, so the image develops from the raster frame into a clean photograph without showing path-tracing noise. The 1.8 MB weights (`public/denoise/`, Apache-2.0) download only when tracing starts.
- **Exposure:** before the first traced image fades in, both it and the frozen raster frame are metered (log-average luminance over a coarse grid, like a camera's matrix meter) and the traced image is scaled to match, within one stop darker to two stops brighter. The handover keeps the brightness the viewer was looking at, while the light distribution (sky occlusion in a courtyard, bounce light in a room) is the traced one.
- **Exports:** photo mode and the PDF brief wait for a denoised image of at least 384 samples, or one whose every region has settled (up to 45 seconds), then save it: a view resting at 256 carries on to 384 while a capture waits, and one asked for before tracing starts begins with that target. Without WebGPU they capture the real-time view as before.

The status line shows progress. The **Path-traced stills** switch under Surroundings turns it off, and says which engine traces (this device, or the cloud when a render server is configured, which serves any browser); it starts on for Ultra and High and off for Lite (on for every tier when a cloud renderer is configured). `?trace=1` or `?trace=0` overrides that, `?denoise=0` shows the raw accumulation for comparison, and `?traceStats=1` logs to the browser console, for each resting view, when its first traced image appeared and when it settled. Tracing runs only while the view rests, with six bounces, and stops once every region has settled (or at 256 samples; 384 for an export), but it does keep a GPU busy for that time; how quickly depends on the GPU and has not been benchmarked on physical hardware.

#### Cloud rendering

The old browser-to-GPU renderer is retired in this candidate. Production builds ignore `VITE_CLOUD_RENDER_URL` and `?cloud=`; direct clients and warm-up calls cannot bypass that gate. Development-only loopback protocol diagnostics remain, without a public/paid authorization. The Python gateway returns non-retryable `LEGACY_RENDER_DISABLED`, and the old Modal deployment and raw-scene server CLI refuse before provider or worker startup.

Do not restore the former per-visitor GPU, CORS-only access, raw scene uploads or browser-selected sample/priority protocol as the new image service. Future private rendering must pass through P04 authenticated configuration-only admission, reservations, fencing and watchdog reconciliation. No provider has been qualified or deployed. See [the retirement scope](docs/p04-legacy-retirement.md).

#### Baked stills

Existing baked-image loading and capture behavior remains in the app, but **new legacy baking is disabled**. `npm run bake` and `npm run bake:quick` exit before building, networking, storage access or manifest changes. `--help` explains the retirement; old `--server`, `--allow-dirty`, `--fresh` and `--blob` options cannot re-enable it.

The still lookup uses the canonical design, camera angle, aspect and renderer identity. Valid export-tier stills can keep the 3D engine unloaded until an unbaked selection or live exploration requires it. The stage waits for decode before showing an image; historical/reference imagery is not silently promoted to an exact current design image.

Source changes can invalidate old renderer identities. Do not edit a manifest to force an old image to match, delete retained images/history, or run the retired bake command to suppress a mismatch warning. Reproducible new imagery belongs to the approved private preparation/worker path. No new images were produced by P04 or this retirement pass.

#### Prefetch

While a section of the configuration panel is open, the current angle's still of each of its other options is rendered ahead, so a click on one usually finds its still ready and swaps it in at once, with no status at all (`src/render/stills.ts`, `src/render/prefetch.ts`, `src/render/siblings.ts`).

- **Which options:** the section last pointed at or focused, else the step's first section that can be prefetched; the option pointed at or focused goes first, then the others nearest the chosen one. One section at a time. A prefetch on its way when the section changes, the 360° View opens or the floor plan does is never cut short: the GPU finishes it anyway, a click may be waiting for it, and nothing new goes out until it lands. The render server answers a request for a frame it is still finishing, or has just cached, from that frame rather than rendering it twice.
- **Only surface swaps:** the cloud renders from a captured scene, so a sibling's scene has to be described without the visitor seeing it. An exterior finish or a floor changes surfaces alone: the sibling is captured from the live scene with its surfaces put on the very meshes a click rebuilds, for the instant of the capture (it reads the scene before its first await), and the meshes get their own surfaces back before anything is drawn. Rebuilding the unit's part lists for the sibling (`src/render/unitParts.ts`, which the model renders from) proves the swap is the whole edit, or the sibling is skipped. Doors, interior styles and settings change geometry, the camera or the light, which would take a live re-render of the scene the visitor would see: they are not prefetched, and a section of them holds nothing back.
- **Nothing for nothing:** a sibling's key is read before its scans or its capture, so one whose still at this angle is in already (a floor seen from outside) costs neither. A sibling's new scans download quietly, one sibling at a time, outside the page's load progress; one whose scans fail is left alone for that design. Siblings whose scans are downloading hold back none of the other angles' stills.
- **Same key as a click:** the still is kept under the key the stage gives the design once clicked (its scene's fingerprints, predicted with the surfaces swapped in), and the server keeps the frame too. The session names the clicked design at once when its scene is exactly the one predicted, so the still swaps in on the next frames, well before the 350 ms after which the status pill would show. A click on an option whose still is still rendering waits for that request (never a second one), and the pill's estimate counts from when it went out.
- **Budget:** after the stage's still and every filmstrip thumbnail, ahead of the other angles' stills; one request at a time (priority 11), at most eight planned or in flight; only when the visitor's own GPU (not the shared warm renderer, which is every arriving visitor's first GPU) answered in the last four minutes, the visitor has not edited for a second, and the gallery is open (never in the 360° View or the floor plan); never on Lite or on this device's tracer; a busy or full answer stops it for a minute. At most 12 prefetches for each design on the stage, and none at all once 30 have gone out since a click last found one ready. A visitor (or a script) pointing at every surface section from every angle renders at most those 12 for each design, where it could otherwise be 45. `?bench=1` counts prefetches sent, landed, and clicks that found theirs.

Lighting:

- **Sun shadows:** the sun's shadow map covers at least 128 × 128 ft around the unit and gathers casters up to about 400 ft toward the sun, so surrounding buildings, trees, and palms shade the site at low sun, as they do in the path-traced image.
- **Sky and sun:** a Preetham daylight sky with clouds is both the visible background and the image-based lighting (captured into a PMREM cube). Sun color comes from atmospheric extinction along the sun path. A multiple-scattering fill keeps the zenith-to-horizon ratio near measured clear skies. Fog matches the horizon. After dark, exposure adapts, moonlight takes over, and airglow keeps the sky deep blue. The sun follows an artistic summer path (sunrise 06:00, sunset 20:30, 60° at noon), not a location-based study.
- **Contact shadows (High, Ultra):** a short screen-space march toward the sun adds the fine shadows a site-wide shadow map cannot resolve: equipment feet on the floor, bench legs on paving, the pod's skirt where it meets the ground. They darken only the sun's light, so lamps and sky light are unaffected.
- **Reflections:** a second radiance probe is captured just in front of the unit with the unit itself hidden. Glazing and the glossy exterior finish reflect it, so they show the actual buildings, trees, and paving around them instead of only the open sky, on every tier. On Ultra, screen-space reflections add what is on screen to chrome, brushed steel, and the coated glass of neighboring office facades. Both probes leave the sky's sun disc out of their captures, since the sun light already lights every surface and the disc would only add fireflies.
- **Interior:** a radiance probe captured from the middle of the room lights and reflects interior surfaces with the room itself (daylight through the glazing, luminaires, finishes) rather than the open sky. It is captured twice per change to approximate a second bounce. Downlights are spot lights; the back-wall cove and toe-kick are rectangular area lights. The interior view meters about +2/3 stop brighter, as a photographer would.
- **Mirror:** High and Ultra render a true planar reflection; Lite uses a probe-lit polished surface.
- **Interior finishes:** gallery and birch interiors use two continuous linear LED channels (area lights on High and Ultra, spot lights on Lite); slatted and cedar interiors use recessed downlights. The Container canopy carries real downlights that wash the ground at night.
- **Settings:** background apartment, office, and house windows are reflective, non-transmissive glazing; a share of them light from inside through dusk. Their glow is a live material property, so the time slider never rebuilds the background geometry.

Materials come from 24 CC0 photo-scanned PBR sets from [Poly Haven](https://polyhaven.com/) (albedo, OpenGL normal, and packed AO/roughness/metalness), plus baked powder-coat, brushed-steel, and knurl detail maps. `public/textures/sources.json` records each set's authors, physical size, and role; `scripts/build-textures.py` (Python 3, Pillow, NumPy) reproduces them. Every model carries UVs measured in feet, so each texture appears at its true physical scale. The ground blends two scales of its scan with noise so it never visibly repeats. Textures stream in after the scene appears, with a progress indicator. Surfaces seen up close and at scale (interior linings and walls, decking, pavers, brick, stucco, concrete, the roll-up door, and the floors) use 2K scans; small-object fabrics, rubber, gravel, bark, and distant ground use 1K. The library is about 40 MB of WebP; only the sets a view needs are downloaded.

Models are procedural and batched: each equipment item or architectural assembly is merged per material into a few draw calls and shared by every placed copy. Trees, shrubs, and blossoms use alpha-tested cards with crown-bent normals and daylight-scaled translucency; fan-palm fronds, grass, and foliage are instanced. Footprint tests keep every equipment model inside the planning envelope the floor-plan collision rules use; a racked Olympic bar on the power rack and half rack is the one deliberate exception, overhanging its uprights into the rack's side clearance as on real racks.

These remain procedural concept models, not manufacturer-verified CAD or photographic scans of Fury products. Equipment is generic. In real time, clear glazing is drawn as thin float glass over the room behind it (Fresnel reflection, nothing blurred), tinted sauna glass and water use physically based transmission, and screen-space GI only bounces light that is on screen; the path tracer resolves both glass and bounced light properly but does not render caustics through thin glass or participating media. Lights do not simulate certified photometry. Photo and PDF exports save the path-traced image when one is ready (a local trace, or the cloud's full-quality frame of the view) and otherwise capture the current real-time view; either way they are the canvas at its on-screen resolution, not a separate offline render.

The three.js chunk is about 1.6 MB minified, 490 kB gzipped, and loads only with the scene: React Three Fiber is pointed at three's WebGPU build, so the classic WebGL renderer is not bundled. The app shell (app code, React, and CSS) is about 460 kB minified, 140 kB gzipped, and paints the configurator before three.js or jsPDF arrive. The path tracer and denoiser are a further chunk of about 310 kB minified, 90 kB gzipped, which loads, with the 1.8 MB denoiser weights, only when tracing starts.

Smoothness and reliability:

- **Nothing runs at rest.** three's own animation loop is stopped; frames are drawn only on demand: for the settle window, and while a resting view is being path traced or a cloud frame fades in (see [Path-traced stills](#path-traced-stills)), then not at all. Sun shadows re-render only when something changes, not on every settle frame. Sub-pixel camera damping no longer extends the settle window.
- **No shader compiles on common toggles.** Lights that come and go (moonlight, interior luminaires, sauna heaters) stay mounted at zero intensity, and foliage, grass, ground, and studio floor materials are kept for the session, so switching lights, time of day, packages, or surroundings reuses compiled shaders instead of stalling. On WebGPU, instanced trees, hedges, and grass read their placements from vertex attributes, so every copy shares its material's shader rather than compiling one per mesh. (A 20↔40 ft change still recompiles lit materials once, because the larger unit has more downlights.)
- **Loading is always visible.** A first visit shows a Fury assembly animation and observed startup phases (downloading the 3D engine, starting the renderer, preparing materials and lighting) until the scene has drawn its first frame, while the configuration panel already works. Changes that rebuild much of the scene (size, product, surroundings, quality) show "Updating the 3D view" a frame before the work starts, and materials streaming in show a progress bar. Progress-bar motion is transform-only; the assembly animation is decorative and independent of progress.
- **Textures decode off the main thread** where the browser supports it, retry on network errors (a whole set that fails tries again after growing pauses, then textures every surface that was waiting), and show neutral stand-ins until they arrive; a failed texture never leaves the progress indicator stuck.
- **Recovery.** If the GPU device or WebGL context is lost, the scene rebuilds its renderer and textures (up to three times) instead of freezing. If the 3D code fails to download, configuration, pricing, and the floor plan keep working with a message in place of the scene; any other unexpected error shows a reload screen instead of a blank page, and the design survives the reload in the page's link.

No 60 fps or low-end mobile performance claim has been validated on physical hardware; the automatic step-down is a safeguard, not a benchmark.

### Loading and render progress

Loading surfaces use the supplied, self-contained Fury assembly animations in `public/builds/`. `buildAnimation.ts` chooses the closest Studio/Container model; startup uses `no-excuses`. Only the currently needed animation is mounted, in a decorative, non-interactive sandboxed iframe. The exports retain their built-in reduced-motion and off-screen behavior; the wrapper also unmounts them while the tab is hidden. Keep these files byte-for-byte when replacing them; they are excluded from formatting.

The assembly is illustrative, **not a visualization of render completion**. The gallery keeps the previous image while preparing the new one and skips the waiting card for swaps faster than 350 ms. A configuration wait says “You’ve got taste,” but does not claim that no other visitor has ever chosen that design: the client cannot know the cloud cache's history.

- Local render progress measures completed samples. At the target it changes to “Finishing,” not a premature success.
- Cloud upload progress counts successfully sent scene assets, not bytes or overall completion. While the render request is outstanding, the bar is indeterminate: the cloud API does not publish live GPU samples or queue position.
- Receipt and image decoding are separate waiting states. Only a decoded image swap announces that the view is ready.
- After 30 seconds, a render wait offers retry and floor-plan controls; a terminal render failure offers them immediately after the status delay. Retrying preserves the design and other cached views, and respects the renderer's busy/full backoff.
- Startup, cached-image loading, material streaming, image downloads, and build-brief preparation reuse the same visual language. Startup phases have no made-up percentages. Material/file percentages describe their own phase only.

`RenderStatus`, `LoadingExperience`, `cloud`, and `stills` tests cover fast swaps, real versus indeterminate progress, late callbacks, retries, tab visibility, and decode-gated completion. Real cloud-GPU progress would require a server telemetry protocol; the UI deliberately does not manufacture it from elapsed time.

## Verification

Vitest covers presets at both sizes with every Studio door and Container opening, family transitions and heights, Container openings and infills, add-on availability per family, signature builds (valid, collision-free, shareable, matching their photographs), Studio door entry positions, schema v1 and v2 migration, custom inquiries, wall/entry/collision constraints, quote-only pricing, share validation, storage failure, undo/redo, real PDF generation for both families, demand-render invalidation, demand-loop frame bookkeeping, on-demand shadow refresh, texture retry and off-thread decoding, share-link throttling and pasted links, saved-build preservation, model part keys, the sun path and sky model, quality and backend selection, material streaming progress, path-traced scene capture and thin-walled glass, sample reuse between views, camera rest after an orbit, the orbit grid and view cache, trace sessions handing over between the cloud and this device, cloud requests and blob syncing, the render session kept across reloads and its warm-up, the spin's geometry and plan (coverage first, the admission of longer renders, drift, idling, exports, interior order, priority clamping), its first-open gate, previews before the textures, a better frame overtaking its preview, frames kept through a resize, the busy backoff and frame timeout, the full-cloud retry, the exposure meter's wait, the plan rebuilt only on a change, an edit in the room costing only the panorama (and one outside only the ring), the scene fingerprinted by part, the scene description serializing the same however the page built it, the bench's marks and medians, every equipment model staying inside its planning footprint, valid batched geometry, both product shells staying inside their nominal envelopes for every door, opening, infill, open state, and length, the four interior finishes, Container additions with both railings, the background buildings, the gallery cameras seeing every build whole past each setting's trees and planters, the angle the 360° View returns to, the 360° View's motion-blur shutter (open while the camera moves, exactly off at rest), and the stage toolbar's tools and its Adjust scene popover. These are not substitutes for browser interaction tests, real-device performance testing, accessibility audits, or manufacturer review. No screenshot-diff or browser E2E suite is included yet.

## Before commercial launch

The following is the historical v3 backlog, not a claim that the new image library is launch-qualified. The static library described above is available now; paid on-demand rendering, approved product data, final art direction and production activation remain separate work. The diagnostic prototype below uses a synthetic, local-only backend.

1. **Verified product data:** replace procedural geometry with approved CAD-derived glTF, confirm shell and add-on dimensions, and obtain licensed equipment assets and manufacturer clearances.
2. **Commercial configuration:** approved prices, taxes, regional delivery/foundation assumptions, deposit/refund terms, finance partner disclosures, production lead times, and warranty/specification copy.
3. **Backend and operations:** provision the intended Supabase project, authentication/RLS, versioned pricing/catalog administration, server-side quote validation, transactional email, CRM routing, and a rep dashboard. Confirm the recipient and retention policy before collecting leads.
4. **Payments:** use server-created, approved-price Stripe Checkout sessions, signed webhook handling, idempotency, and refund handling; never trust the client estimate as a charge amount.
5. **Visual and spatial services:** validated glTF/USDZ export, physical-device AR/VR, actual first-person navigation, photoreal asset pipeline, high-resolution path-traced capture, share-preview rendering, and performance budgets.
6. **Site and AI layers:** licensed map/parcel data, sourced zoning guidance, calibrated geospatial shadows, privacy controls for uploaded photos, and a model-backed assistant restricted to validated configuration tools and approved source documents.
7. **Release gate:** desktop/mobile E2E and accessibility audits, field-tested PDF and sharing, renderer fallback testing, observability with appropriate consent, and legal/product sign-off.

The configurator does **not** certify construction, safe installation, site fit, zoning, engineering, delivery feasibility, or equipment suitability. All such decisions require qualified local review.

## Local image-first diagnostic prototype

This DEV-only mode is retained for testing the image-service contracts. For the actual 400-image experience, use `/?experience=library` instead.

This adapts the actual existing configurator, not a second lookalike screen. Both routes consume the extracted `ConfiguratorShell`, `ConfigPanelView`, `StageHeader`, `StagePresentation`/hooks, `StageToolbarView`, `BuildDialogView`, `SpecificationView` and existing `FloorPlan`. Legacy adapters retain v3 renderer/prefetch/equipment/PDF/inquiry behavior. V4 emits canonical DesignAction, keeps fixed DRAFT arrangements read-only, and uses `usePrototypeImage`; duplicate prototype workspace/control/plan markup and layout styling have been removed. Existing `styles.css` and the Fury theme remain unchanged by convergence. See the [shared interface map](docs/image-first-prototype.md#shared-source-and-adapter-interfaces).

The next-batch integration uses the existing application entry, not the separate layout-review page. It adds a provisional full-v4 configuration contract, atomic history, isolated explicit saves/shares, a loopback-only mock image API with SQLite jobs/reservations, and private CPU scene/fixture preparation. It does **not** approve the equipment, qualify a display engine, deploy anything or generate current photorealistic imagery.

For local development with existing dependencies and Node 24.22.0:

```sh
FURY_IMAGE_PROTOTYPE=1 npm run dev -- --host 127.0.0.1
```

Then open the local application's `/?prototype=images` path. The separately approved convergence pass used preserved local fixtures and mock-ON/OFF services on loopback ports 5203/5204, without resetting budgets or creating replacement principals. A new 214-second foreground recording covers the adapted B-based interface; earlier prototype recordings do not establish this revision's acceptance. See [browser evidence and limits](docs/image-first-prototype.md#recorded-browser-checks-and-remaining-gaps) for scope, evidence paths and remaining gaps, including a separate 3px background-page overflow at 320px. Shared source/classes and jsdom checks do not establish pixel parity, image quality or physical-device performance. Ordinary URLs and production builds keep the v3 experience. The prototype never falls back to paid/cloud rendering. Its photo is persistently labeled **Historical reference — not this configuration**; its generated SVGs are diagnostics, not product pictures. Its 32-retained-interest limit can stop previews during ordinary repeated changes; this is explicitly reported without a misleading immediate Retry, not resolved by resetting budgets.

Read [UI/persistence behavior](docs/image-first-prototype.md), [mock-service operation and limits](docs/prototype-image-service.md), and [private scene preparation](docs/prototype-scene-fixtures.md) before using this mode. Production activation, real-device testing, approved assets, engine comparison and any spending require separate gates.

### Local real-image slice — first pair captured

An additional **DEV-only** `/?prototype=images&imageMode=local-real` selection connects the same B-based interface to a separate strict local PNG service. It requires both `FURY_IMAGE_PROTOTYPE=1` and `FURY_LOCAL_REAL_IMAGES=1`; mock/default v3 behavior is unchanged. Only the fixed Studio-20 front-left wide Obsidian/Bronze pair is in scope. Other designs remain editable but have no matching rendered preview; historical/mock images are never substituted as current renders.

**Two actual PNGs are now captured and independently verified:** Studio-20 Obsidian and Bronze, same authored camera and build, differing only in finish. The approved extra retry succeeded after correcting browser-wide request interception; Bronze then succeeded within its original sample allowance. Real loopback HTTP checks prove A→B→A byte reuse, duplicate Bronze coalescing and service restart without recapture. Both images remain **640×400 software/Lite pipeline evidence**, visibly below the final quality target; capture took about 52–54 seconds each. The original ledger is intact (three failures, two successes, all three diagnostic retries used); successful samples cannot be rerendered implicitly. See [real-image contract, operation and evidence](docs/local-real-image-slice.md) and [private capture requirements](docs/prototype-local-capture.md). The preserved image-only browser pass subsequently passed at all three laptop sizes using these captures; P03 does not rerun it. Art/renderer qualification and physical-device performance remain outstanding. Nothing was deployed or rendered on paid compute.
