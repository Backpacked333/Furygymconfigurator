# FURY / Container Gyms + S-Series Studios

A laptop-first configurator built for [Fury Co Gyms](https://www.furycogyms.com/), designed around 12–16-inch displays (roughly 1280–1728 CSS pixels wide). Explore separate Container Gym and S-Series Studio families, choose published options, arrange generic equipment in a collision-aware floor plan, and take away a shareable concept design and PDF inquiry brief. Mobile has a basic responsive fallback but is not the primary experience.

**This is a working concept configurator, not a live purchasing system.** Published family starting prices are source-backed, but every selected build requires a quote. Geometry is not manufacturer CAD; finish palettes, floor looks, equipment, and working clearances are generic visual studies. No customer details, payments, or sales emails are sent anywhere. The official inquiry link opens Fury's website without transferring this configuration.

## Official product sources

Reviewed **October 14, 2026**. `src/lib/products.ts` contains the source URLs, nominal heights, features, starting prices, and published option names. These are a dated snapshot, not a live pricing feed.

| Family                                                            | Nominal exterior sizes                     | Published family starting price | Published choices                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Container Gyms](https://www.furycogyms.com/gym-design/container) | 20′ or 40′ L × 8′ W × 9′6″ H; 160 / 320 SF | $20,000 USD                     | 10′ roll-up door; center, partial, full open-side; integrated exterior finish                                     |
| [S-Series Studios](https://www.furycogyms.com/gym-design/studio)  | 20′ or 40′ L × 8′ W × 10′ H; 160 / 320 SF  | $35,000 USD                     | Front deck, gazebo, rooftop deck, exterior stairs; connected, double-wide, multi-level, stacked, custom inquiries |

Fury does **not** publish separate 20′/40′ prices or a full option price list on these pages. Starting prices therefore never scale by length or become configured totals. `estimate()` returns `total: null` and `amount: null` for unpriced selections—not zero. There is no financing calculator based on an invented principal. The [project inquiry page](https://www.furycogyms.com/start-a-project) separately says smaller entry-level projects typically start at $25,000; this is different project guidance, not an extra fee added to the Container starting price.

Connected and stacked Studio requests are saved in the design and brief, but the scene and floor plan show **one reference unit**, not an engineered assembly. The website does not specify unit counts, connection geometry, loads, or permitted arrangements. Other door widths and colors are also inquiry-only. Performance flooring is published; the app's oak/stone looks, timber accent, named colors, mirror wall, and equipment presets are not an approved Fury catalog.

## Run locally

Requirements: **Node.js 24 LTS** and npm. The runtime version is declared in `.nvmrc`; dependencies are locked in `package-lock.json`.

```sh
nvm install
nvm use
npm ci
npm run dev
```

Open the URL printed by Vite. If you do not use nvm, install Node 24 and run the npm commands directly. No environment variables, API keys, database, or third-party accounts are required. Fonts, models, textures, and scripts are bundled or generated locally; there are no remote model, texture, or font requests at runtime.

Optional URL parameters help when comparing devices or debugging: `?renderer=webgl` forces the WebGL 2 backend, `?quality=ultra|high|lite` fixes the render tier (and disables the automatic step-down), and `?debug=ao` or `?debug=normal` shows the ambient-occlusion or normal buffer on High and Ultra.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
node scripts/check-delivery.mjs
npm run preview
```

`npm run format` applies Prettier. CI runs formatting, ESLint, TypeScript, Vitest, and the production build. There are no custom pre-commit hooks. Production output is `dist/`, suitable for Vercel, Netlify, Cloudflare Pages, or another static host. Configure `npm run build` as the build command and `dist` as the output directory; serve the app over HTTPS for clipboard sharing and WebGPU (browsers only expose WebGPU to secure contexts). Do not expose Vite's development server as the public production service.

The hosting configuration targets Vercel; no deployment is required for local use. `vercel.json` caches content-hashed `/assets/*` for a year. Production material maps use verified, hashed asset URLs; unversioned `/textures/*` must revalidate. `scripts/check-delivery.mjs` checks the built import graph, lazy Scene/PDF boundaries, shell budget, and all 60 map hashes against `public/textures/manifest.json`. Run it after building. Catalog bytes are not cold-start transfer or measured GPU memory.

## What works

| Area          | Implemented                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products      | Two families, 20-/40-foot footprints, family-specific nominal heights and source-linked features                                                                        |
| Exterior      | Container opening previews and integrated finish request; independent Studio front deck, gazebo, rooftop deck, stairs; four concept colors                              |
| Visualization | WebGPU renderer with WebGL 2 fallback, photo-scanned materials, physical sky and sun by time of day, exterior orbit, interior look-around, three environments, lights   |
| Rendering     | Ultra (screen-space GI), High (GTAO, bloom, temporal AA), Lite (MSAA); interior radiance probe, planar mirror, area-light washes, automatic quality step-down           |
| Interior      | Strength, recovery, movement, cardio, and empty presets; ten generic equipment items                                                                                    |
| Floor plan    | Pointer dragging, quarter-foot snapping, rotation, removal, entry and boundary protection, collision rejection, visible working-space envelopes                         |
| Decisions     | Published family starting prices, unpriced quote checklist, custom Studio inquiry request, 50-step undo/redo, concept starter builds                                    |
| Persistence   | Automatic local draft, up to 12 named local builds, two-build comparison, versioned compressed share URLs                                                               |
| Deliverables  | Configuration JSON, current-view PNG, multipage PDF with scene image when available, floor plan, sourced starting price, quote checklist, notes, and share link         |
| Access        | Responsive controls, touch interaction, keyboard camera and floor-plan controls, labeled options, focus-trapped dialogs, reduced-motion camera transitions, 2D fallback |

### Controls

- **Exterior:** drag to orbit, pinch or scroll to zoom. Focus the scene for arrow keys and `+`/`−`.
- **Interior:** drag or use arrows to look around from a fixed point inside the studio. This is not a collision-enabled walk-through.
- **Floor plan:** drag an item; arrows move it 3 inches, Shift+arrows move it 1 foot, `R` rotates, Delete/Backspace removes. Invalid moves are rejected with an explanation. Rotation is 0° or 90°.
- **History:** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes. Changing size preserves selections, and downsizing is blocked if current equipment would no longer fit.
- **Photo mode:** choose the exact current-view aspect or a visible, centered 16:9 crop. Native output includes 3840×2160 only when capability/memory preflight permits it; lower resolutions remain available. Capture is cancellable and reports rendered and encoded dimensions. This is real-time raster rendering, not path tracing or an upscaled substitute.

## Configuration architecture

One validated, versioned `Config` object drives the scene, layout, quote checklist, share payload, and PDF. `src/lib/config.ts` owns the Zod schema, planning equipment, presets, validation rules, unit conversions, and quote semantics. `src/lib/products.ts` owns the sourced product facts. Never add prices separately in a component or PDF.

```text
src/
  App.tsx                     Workspace, dialogs, camera modes, history shortcuts, quality governor
  components/
    ConfigPanel.tsx           Four-step selection interface
    Scene.tsx                 Async WebGPU canvas, camera, dimensions, graphics fallback
    RenderEffects.tsx         Drives the TSL pipeline, settle frames, captures, frame-time governor
    Atmosphere.tsx            Physical sky, fog, image-based lighting, sun and moon, exposure
    InteriorProbe.tsx         Radiance probe captured inside the room for interior surfaces
    InteriorLights.tsx        Downlights, cove and toe-kick area lights, fixtures
    StudioModel.tsx           Shell, interior, glazing, add-ons, signature, mirror, equipment
    Equipment.tsx             Batched equipment models shared by every placed copy
    Landscape.tsx             Anti-tiled ground, hardscape, trees, hedge, grasses, desert plants
    Mirror.tsx                Planar reflector (High/Ultra) or probe-lit metal (Lite)
    Parts.tsx                 Renders a part list as merged, per-material meshes
    FloorPlan.tsx             Accessible SVG floor-plan editor
    Dialogs.tsx               Saved comparisons, quote checklist, sharing
    BriefDialog.tsx           Frozen-config PDF, image-free option, progress and cancellation
    RecoveryDialog.tsx        Original-byte downloads, explicit repair/acceptance
    ImageExportControls.tsx   Current-view and native 16:9 capture controls
    useExportJob.ts           Revision/provider/generation-safe asynchronous export jobs
    Modal.tsx                 Native dialog lifecycle
  render/
    renderer.ts               WebGPURenderer creation, area-light tables, texture-view shim
    pipeline.ts               TSL render pipelines per quality tier
    quality.ts                Tiers, backend selection, defaults (no three.js imports)
    materials.ts              Material library over the scanned texture sets
    palette.ts                Named physically based materials (powder coat, vinyl, glass...)
    geometry.ts               Geometry helpers with UVs in feet, corrugation, tubes, lathes
    parts.ts                  Part lists and static batching
    architecture.ts           Studio and Container shells, interiors, glazing
    addons.ts                 Deck, pergola, roof deck, stairs, timber accent
    equipment.ts              Ten equipment models at real-world dimensions
    vegetation.ts             Leaf atlas, trees, grass, foliage materials
    progress.ts               Material streaming progress (no three.js imports)
    useResource.ts            StrictMode-safe GPU resource lifetime
  lib/
    config.ts                 Domain model, rules, estimates, URLs, persistence
    products.ts               Official product facts, sources, and published choices
    useConfig.ts              Reducer-backed history and automatic draft
    spatial.ts                Shared physical envelopes, elevations, openings and site context
    editTransactions.ts       Preview/commit/cancel ownership and bounded committed history
    repository.ts             Transactional IndexedDB records, CAS conflicts and tombstones
    draftSession.ts           Preservation, draft write barriers and explicit recovery
    recovery.ts               Bounded original-byte retention and storage-failure outcomes
    capture.ts                Shell-safe asynchronous capture registry and contracts
    presentation.ts           Renderer-generation and committed-presentation readiness
    export.ts                 On-demand PDF generation and downloads
    visuals.ts                Sun path, Preetham sky model, sunlight color, horizon fog
scripts/
  build-textures.py           Fetches CC0 scans and bakes procedural detail maps
public/textures/              Bundled texture sets and sources.json (authors, sizes, roles)
```

Dimensions use **feet internally**, with x along unit length, y up and positive z toward the front. `spatial.ts` is the shared source for the finished floor, family/lining-specific usable walls and ceiling, occupied equipment bounds (including protrusions and origin offsets), entries, openings, external elevations and site context. SVG/PDF planning and placement validation consume this contract. Only the Container roll-up width is published; other opening widths/positions and all deck/gazebo/stair geometry are illustrative. Working-space guidance is separate from physical occupancy and is **not manufacturer safety clearance, electrical guidance, accessibility approval, structural loading or permitted occupancy**.

Rules:

- Studio additions are distinct from reference-backed Container deck/roof/stair concepts. The modeled stair needs its roof destination; this is a construction-model dependency, not a claim about Fury engineering. Invalid older stairs-only designs open for repair rather than silently losing selections.
- Family changes are rejected when a current family-only selection or physical layout cannot be retained; they never silently clear options or delete equipment. The generic rack's measured top exceeds the Container usable ceiling. Container Strength therefore offers bench/dumbbells, and legacy rack layouts remain recoverable rather than being shrunk or accepted through the ceiling.
- Concept templates keep the chosen product family but reset the reference footprint to 20 feet after confirmation.
- Malformed, unsupported, oversized and structurally invalid inputs are preserved within explicit recovery limits; they are not silently replaced with an autosaved default. Schema-valid but spatially invalid designs can enter a suspended repair workspace. Correct them deliberately, then explicitly accept the valid repair before automatic saving resumes.
- Schema `v: 3` adds `openingConcept` and `presentation` (`openingPose`, `context`) without erasing the v2 product-family fields. v1/v2 migration preserves choices and original source data. Sectional/raised glazing, open-front and hinged-solid studies are reference-backed concepts, not published manufacturing options. Custom wellness and sunken-lounge context are inquiry/site-only and excluded from product pricing and interior equipment occupancy.

### Local data and sharing

The URL fragment `#c=…` contains the entire LZ-string-compressed configuration. It updates with edits and is not sent in HTTP requests to the static host. Anyone with the full link can read the configuration. There is no short-link service, authentication, cross-device account, or automatic social-preview image. A link needs a running deployment of this app; localhost and session-preview links are not permanent public links.

The `fury-documents-v1` IndexedDB repository stores individual drafts, named builds, recovery records and deletion tombstones. Writes use revision-checked transactions; simultaneous-tab conflicts are explicit instead of last-writer-wins overwrites. Legacy localStorage drafts/libraries are imported with per-record salvage and original retention; unreadable records do not hide valid siblings. A valid shared design can displace the local draft only through preservation. Invalid incoming links suspend unsafe writes and retain the current design and rejected source. Preview gestures do not persist or change share URLs; only committed, accepted documents do.

The recovery panel downloads originals and the current in-memory configuration, opens invalid candidates for repair after preserving both designs, and explicitly resumes saving after a valid repair. Storage failures, conflicts and retention limits remain visible. Clearing browser storage removes local drafts, saved builds and recovery copies, so download important designs first. Recovery copies are bounded, not an unlimited backup service. There is no cloud synchronization.

PDF generation loads jsPDF only on export intent. It binds the committed configuration to the captured revision, camera policy, renderer generation and asset state; superseded or cancelled jobs cannot download stale output. In floor-plan mode, or when choosing the image-free option, no old 3D screenshot is reused. Floor plans, separate elevation/site overlays, notes, source links and quote sections still export. Core fonts support ASCII/Latin-1 plus normalized common punctuation; unsupported scripts produce a visible error rather than missing glyphs. No analytics or session replay is installed.

### Rendering and performance

The scene renders with three.js r186's `WebGPURenderer`. It runs natively on WebGPU and falls back to its WebGL 2 backend automatically, so every material and post effect is written once in TSL (three's shading language) and works on both. React Three Fiber creates the renderer asynchronously. The renderer badge in the scene status line shows the active backend and tier.

| Tier  | Pipeline                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Ultra | High plus screen-space global illumination (one diffuse bounce of on-screen light)                                                              |
| High  | Depth/normal/velocity pre-pass, GTAO applied only to ambient light, emissive bloom, temporal reprojection anti-aliasing, 4096-pixel sun shadows |
| Lite  | One 4× MSAA pass, 1024-pixel sun shadows, probe-lit mirror                                                                                      |

Auto admission is capability-aware: unknown/software profiles start conservatively on Lite, not Ultra merely because the window is wide. Sustained active-frame sampling, cooldown and hysteresis govern automatic step-down; a valid explicit tier override locks the choice until Auto is restored. Invalid URL overrides do not disable Auto. Rendering is on demand, with bounded refinement after meaningful changes and probe work deferred until active material loading settles. The status reports actual CSS and drawing-buffer dimensions; a tier label is not a native-resolution guarantee.

Lighting:

- **Sky and sun:** a Preetham daylight sky with clouds is both the visible background and the image-based lighting (captured into a PMREM cube). Sun color comes from atmospheric extinction along the sun path. A multiple-scattering fill keeps the zenith-to-horizon ratio near measured clear skies. Fog matches the horizon. After dark, exposure adapts, moonlight takes over, and airglow keeps the sky deep blue. The sun follows an artistic summer path (sunrise 06:00, sunset 20:30, 60° at noon), not a location-based study.
- **Interior:** a radiance probe captured from the middle of the room lights and reflects interior surfaces with the room itself (daylight through the glazing, luminaires, finishes) rather than the open sky. It is captured twice per change to approximate a second bounce. Downlights are spot lights; the back-wall cove and toe-kick are rectangular area lights. The interior view meters about +2/3 stop brighter, as a photographer would.
- **Mirror:** High and Ultra render a true planar reflection; Lite uses a probe-lit polished surface.

Materials come from 18 CC0 photo-scanned PBR sets from [Poly Haven](https://polyhaven.com/) (albedo, OpenGL normal, and packed AO/roughness/metalness), plus baked powder-coat, brushed-steel, and knurl detail maps. `public/textures/sources.json` records authors, physical sizes and roles; `scripts/build-textures.py` (Python 3, Pillow, NumPy) reproduces them. UVs use feet and the ground blends two scan scales with noise. Active mounted owners request only their maps. Albedo/normal/ARM outcomes are independent: failures use visible fallbacks, successful siblings stay bound, and manual retries are finite. Three concurrent download/decode slots have deadlines that start on admission rather than while queued. Readiness distinguishes pending, settled and degraded; settled fallbacks are not source-map success or proof of GPU upload.

Models are procedural and batched: equipment and architecture are merged per material, while grass and foliage are instanced. Physical bounds include the rack's Olympic bar and every measured protrusion; there is no overhang exception hidden in advisory clearances. Model/contract tests compare generated geometry across rotations, families and sizes. Construction includes explicit seams, reveals, corrugation, hardware, opening poses, connected stair/landing geometry and generic equipment detail. These remain illustrative, not manufacturer CAD or certified dimensions.

These remain procedural concept models, not manufacturer-verified CAD or photographic scans of Fury products. Equipment is generic. Glass and water use physically based transmission, not traced caustics. Lights do not simulate certified photometry, and screen-space GI only bounces light that is on screen. Photo and PDF exports capture the current real-time view; they are not offline path-traced renders.

Scene and PDF dependencies stay behind separate dynamic import boundaries; use the delivery report from the current build for exact compressed sizes. No 60 fps, low-end mobile, physical-GPU or native-4K hardware performance claim is established by shell tests or software-renderer runs. Auto quality and preflight are safeguards, not device certification.

## Verification

Vitest covers schema/migration/raw retention, atomic repository conflicts, suspended repair, preview/history ownership, measured spatial parity, actual PDF generation, lazy delivery, per-channel material retry, renderer/capture lifecycle, quality policy and camera bounds. Injected renderer/GL doubles are not physical-device evidence. Development fixtures under `src/dev/visual` cover VF01–VF12 and all nine supplied references; they are not imported by the customer entry. The neutral stage is available from Vite at `/src/dev/visual/index.html`.

`src/dev/asset-pilot` contains an isolated, provenance-pinned GLB/KTX2 experiment. Neither asset format was adopted in production: the sampled bike was not reference-quality, and the sampled KTX2 payload was larger than WebP before decoder cost. GPU transcode, visual/motion quality and device working-set benefits remain unmeasured. The pilot's result does not waive procedural geometry or material defects.

Release evidence must separately identify automated checks, integrated browser results, actual decoded PNG/PDF inspection, reference/detail comparisons, human premium approval and physical-device measurements. A test count, tier label, fixture definition or software-renderer screenshot cannot certify the other categories. There is no committed full browser E2E suite; session recordings/reports document what was actually exercised.

## Before commercial launch

The supplied six-phase roadmap remains the product direction, not a claim that every phase has shipped. The current release is a self-contained frontend foundation plus useful interior-planning and decision tools. Production integrations are deliberately absent rather than simulated.

1. **Verified product data:** replace procedural geometry with approved CAD-derived glTF, confirm shell and add-on dimensions, and obtain licensed equipment assets and manufacturer clearances.
2. **Commercial configuration:** approved prices, taxes, regional delivery/foundation assumptions, deposit/refund terms, finance partner disclosures, production lead times, and warranty/specification copy.
3. **Backend and operations:** provision the intended Supabase project, authentication/RLS, versioned pricing/catalog administration, server-side quote validation, transactional email, CRM routing, and a rep dashboard. Confirm the recipient and retention policy before collecting leads.
4. **Payments:** use server-created, approved-price Stripe Checkout sessions, signed webhook handling, idempotency, and refund handling; never trust the client estimate as a charge amount.
5. **Visual and spatial services:** validated glTF/USDZ export, physical-device AR/VR, actual first-person navigation, photoreal asset pipeline, high-resolution path-traced capture, share-preview rendering, and performance budgets.
6. **Site and AI layers:** licensed map/parcel data, sourced zoning guidance, calibrated geospatial shadows, privacy controls for uploaded photos, and a model-backed assistant restricted to validated configuration tools and approved source documents.
7. **Release gate:** desktop/mobile E2E and accessibility audits, field-tested PDF and sharing, renderer fallback testing, observability with appropriate consent, and legal/product sign-off.

The configurator does **not** certify construction, safe installation, site fit, zoning, engineering, delivery feasibility, or equipment suitability. All such decisions require qualified local review.
