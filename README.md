# FURY / Container Gyms + S-Series Studios

A laptop-first configurator built for [Fury Co Gyms](https://www.furycogyms.com/), designed around 12–16-inch displays (roughly 1280–1728 CSS pixels wide). Explore separate Container Gym and S-Series Studio families, choose published options and an interior planning package, browse seven pre-rendered views by day or night in four surroundings, step into a live 360° view, and take away a shareable concept design and PDF inquiry brief. Mobile has a basic responsive fallback but is not the primary experience.

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

Open the URL printed by Vite. If you do not use nvm, install Node 24 and run the npm commands directly. No API keys, database, or third-party accounts are required. The one optional environment variable, `VITE_STILLS_BASE`, points at published pre-rendered stills (see [Stills](#stills)); without it, the live 3D view draws every still. Fonts, models, textures, and scripts are bundled or generated locally; there are no remote model, texture, or font requests at runtime.

Optional URL parameters help when comparing devices or debugging: `?renderer=webgl` forces the WebGL 2 backend, `?quality=ultra|high|lite` fixes the render tier (and disables the automatic step-down), and `?debug=ao` or `?debug=normal` shows the ambient-occlusion or normal buffer on High and Ultra.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run preview
```

`npm run format` applies Prettier. CI runs formatting, ESLint, TypeScript, the scene-version guard, Vitest, the production build, and a browser smoke test of the stills-first page (`render/src/smoke.ts`). There are no custom pre-commit hooks. Production output is `dist/`, suitable for Vercel, Netlify, Cloudflare Pages, or another static host. Configure `npm run build` as the build command and `dist` as the output directory; serve the app over HTTPS for clipboard sharing and WebGPU (browsers only expose WebGPU to secure contexts). Do not expose Vite's development server as the public production service.

The project deploys on Vercel. `vercel.json` caches Vite's content-hashed `/assets/*` for a year and the bundled `/textures/*` for a day with background revalidation, since texture filenames are not hashed. If you regenerate a texture set, returning visitors may see the previous version for up to a day.

## What works

| Area          | Implemented                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products      | Two families, 20-/40-foot footprints, family-specific nominal heights and source-linked features                                                                          |
| Exterior      | Container opening previews and integrated finish request; independent Studio front deck, gazebo, rooftop deck, stairs; four concept colors                                |
| Visualization | Seven pre-rendered views per build (five outside, two inside), Day and Night, four surroundings, live 360° view with WebGPU and WebGL 2 fallback, photo-scanned materials |
| Rendering     | Ultra (screen-space GI), High (GTAO, bloom, temporal AA), Lite (MSAA); interior radiance probe, planar mirror, area-light washes, automatic quality step-down             |
| Interior      | Strength, recovery, movement, cardio, and empty planning packages; ten generic equipment items                                                                            |
| Floor plan    | Read-only drawing of the chosen package with planned entry and illustrative working-space envelopes                                                                       |
| Decisions     | Published family starting prices, unpriced quote checklist, custom Studio inquiry request, 50-step undo/redo, concept starter builds                                      |
| Persistence   | Automatic local draft, up to 12 named local builds, two-build comparison, versioned compressed share URLs                                                                 |
| Deliverables  | Configuration JSON, full-size view PNG, multipage PDF with the current view, floor plan, sourced starting price, quote checklist, notes, and share link                   |
| Access        | Responsive controls, touch interaction, keyboard angle and camera controls, labeled options, focus-trapped dialogs, reduced-motion camera transitions, 2D fallback        |

### Controls

- **Gallery:** pick one of seven views in the angle strip (arrow keys move between them), switch surroundings and Day/Night on the stage. Each still swaps in only once it has fully loaded.
- **360°:** starts from the view on screen. Outside, drag to orbit, pinch or scroll to zoom; inside, drag or use arrows to look around from where the view was taken. Focus the scene for arrow keys and `+`/`−`. This is not a collision-enabled walk-through.
- **Floor plan:** a read-only drawing of the chosen planning package. Choose another package under Interior.
- **History:** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes. Changing size preserves selections.
- **Photo mode:** downloads the current view as a PNG: the full-size pre-rendered still when stills are published, otherwise the live canvas. It is not path tracing.

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
    Landscape.tsx             Courtyard, studio floor, and the switch between surroundings
    environments/             Backyard and rooftop settings; shared ground, trees, hedge, grass
    stills/                   Still stage (stacked layers, decode-then-fade) and angle strip
    Prewarm.tsx               Compiles unchosen items, finishes and floors while the 360 view idles
    Mirror.tsx                Planar reflector (High/Ultra) or probe-lit metal (Lite)
    Parts.tsx                 Renders a part list as merged, per-material meshes
    FloorPlan.tsx             Read-only SVG floor plan of the chosen package
    Dialogs.tsx               Saved comparisons, quote checklist, sharing, brief form
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
    export.ts                 On-demand PDF generation and downloads
    visuals.ts                Sun path, sky presets per surroundings, sunlight color, horizon fog
    lighting.ts               Day/Night as sun-path times; studio is always day
    cameras.ts                The seven still poses and framing, shared with the 360 view
    renderKey.ts              Content keys and URLs of pre-rendered still layers
    stills.ts                 Which layers make each still; every layer the batch must render
    stillImages.ts            Published-stills check, prefetch queue, hero preload
  render-harness/             Headless `?render` page the batch renderer drives
render/                       Offline batch renderer for the stills (see render/README.md)
scripts/
  build-textures.py           Fetches CC0 scans and bakes procedural detail maps
  build-live-textures.py      1K copies of the 2K scans for the live view
  check-scene-version.mjs     Fails CI when render inputs change without a SCENE_VERSION decision
public/textures/              Bundled texture sets and sources.json (authors, sizes, roles)
```

Dimensions use **feet internally**, with x along unit length and z along depth; the front is positive z. Both families are 20/40 × 8 feet, with heights from the product table above. Equipment comes only from the planning packages, each checked against a conservative concept usable envelope and a planned entry aligned to the chosen opening. Only the roll-up width is published; other opening widths/positions and all deck/gazebo/stair geometry are illustrative. Collision checks cover equipment footprints and a small placement buffer, **not manufacturer safety clearances, electrical requirements, accessibility, structural loading, or permitted occupancy**. Dashed envelopes are illustrative guidance and can overlap.

Rules:

- Studio add-ons can be selected individually or together, as the Studio page describes. The former automatic gazebo/deck and stairs/roof dependencies were prototype assumptions, not published engineering rules, and have been removed. All combinations still require support/access/engineering review; the model is not certification.
- Switching to Containers clears Studio-only additions, timber accents, and custom Studio requests while preserving shared finishes, length, and the planning package. Switching families resets opening-specific selections. Undo restores the previous state.
- Concept templates keep the chosen product family but reset the reference footprint to 20 feet after confirmation.
- Invalid, unsupported, or oversized shared configurations are rejected.
- Schema `v: 3` makes every configuration listable in advance, so each has pre-rendered stills: equipment comes from the package (`items` and the `custom` package are gone), `lighting: day | night` replaces the time of day, and surroundings are courtyard, backyard, rooftop, or studio. Version 2 links, drafts, and saved builds migrate: the desert becomes the rooftop, evening times become Night, and a hand-arranged layout becomes the closest package with a notice. Architectural lighting is always on by day; the toggle applies after dark.
- Schema `v: 2` adds `family`, `containerOpening`, `integratedFinish`, and `studioLayout`. Legacy `v: 1` links/drafts/saved builds migrate automatically to Studios and are fully revalidated. Existing selections are preserved; old conceptual prices are not. Unsupported versions are rejected. This is the implemented app contract, not a roadmap example.

### Local data and sharing

The URL fragment `#c=…` contains the entire LZ-string-compressed configuration. It follows edits within half a second (at once when the tab is hidden or closed), so dragging a slider does not rewrite browser history on every step, and it is not sent in HTTP requests to the static host. Pasting another design's link into an open tab loads it; Undo returns to the previous design. Anyone with the full link can read the configuration. There is no short-link service, authentication, cross-device account, or automatic social-preview image. A link needs a running deployment of this app; localhost and session-preview links are not permanent public links.

`fury-draft-v1` and `fury-builds-v1` remain the only localStorage keys to preserve existing drafts and saved builds; their payloads migrate to schema v3. A valid URL configuration takes precedence over the draft. Storage failure does not prevent configuration or file export; named-save failures show a message. Clearing browser storage removes local drafts and saved builds, so export important designs.

PDF generation loads jsPDF only when needed. The brief uses the full-size still of the current view, or the live canvas when stills are not published; the image is omitted in floor-plan mode or when neither is available; the floor-plan drawing and other brief sections still export. Core PDF fonts target Latin-script text. No analytics or session replay is installed.

### Stills

The page opens on pre-rendered stills, not the 3D engine. Seven angles per build (`src/lib/cameras.ts`) are rendered offline by the batch renderer in `render/` and published as static AVIF/WebP files (640, 1024, and 2048 px wide) to a CDN such as Cloudflare R2. No server runs per visit.

- **Every build has stills.** Front-facing exterior views see the room through the glazing or opening, so they are two layers stacked in the browser: a shell (with alpha where the room shows, glass keeping its reflection) over an interior. Each layer's key hashes only what it can show (`src/lib/stills.ts`), which brings every combination down to about 56,800 layers.
- **Fast and steady.** The hero still is preloaded before React mounts; no three.js loads before it shows. A new still replaces the old one only after all its layers have decoded, then fades in. Neighboring angles, the other lighting, and the thumbnails prefetch at low priority; hovering an option prefetches what it would show.
- **Cameras never jump.** Each angle uses one camera per product and size, whatever the additions, so options crossfade in place. The live view uses the same pose, cropped like the image, so stepping into 360° starts from the picture on screen.
- **Always something to show.** The app uses published stills only once the batch's ready marker for this renderer and scene version exists. Without it (no `VITE_STILLS_BASE`, a deploy ahead of its batch, or a layer that fails to load), the live 3D view draws each still from the same camera instead. With stills, a 3D failure only costs the 360 view.
- **360° on demand.** After the first still shows, the 3D view warms up out of sight (skipped with Save-Data or little device memory), so entering 360° is immediate. While the camera moves it draws with the Lite pipeline and refines to the device's tier 150 ms after it stops; when idle, it compiles the items, finishes, floors, and additions not yet chosen, so picking them never stalls.

`SCENE_VERSION` in `src/lib/renderKey.ts` is part of every key. Bump it with any visual change and re-render; `npm run scene-version` (in CI) fails when render inputs change without a recorded decision. See `render/README.md` for batches, GPU hosts, verification, and audits.

### Rendering and performance

The scene renders with three.js r186's `WebGPURenderer`. It runs natively on WebGPU and falls back to its WebGL 2 backend automatically, so every material and post effect is written once in TSL (three's shading language) and works on both. React Three Fiber creates the renderer asynchronously. The renderer badge in the scene status line shows the active backend and tier.

| Tier  | Pipeline                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Ultra | High plus screen-space global illumination (one diffuse bounce of on-screen light)                                                              |
| High  | Depth/normal/velocity pre-pass, GTAO applied only to ambient light, emissive bloom, temporal reprojection anti-aliasing, 4096-pixel sun shadows |
| Lite  | One 4× MSAA pass, 1024-pixel sun shadows, probe-lit mirror                                                                                      |

Laptop-width screens start on Ultra, tablets on High, and phones on Lite. If back-to-back frames stay slow, the app steps down one tier and says so, unless a tier was chosen explicitly. Rendering is on demand: after any change it keeps drawing for a short settle window (about 28–40 frames) so temporal anti-aliasing, AO, and GI converge into a clean still, then stops.

Lighting:

- **Surroundings:** a walled courtyard, a suburban backyard (cedar fence, patio, the house beyond with lit windows at night), an urban rooftop terrace (parapet and glass rail, plant, planters, and instanced towers whose windows light up at night), or a photo-studio floor.
- **Sky and sun:** a Preetham daylight sky with clouds is both the visible background and the image-based lighting (captured into a PMREM cube). Day is a late-afternoon sun; Night is the blue hour after sunset. The studio is always lit as day. Sun color comes from atmospheric extinction along the sun path. A multiple-scattering fill keeps the zenith-to-horizon ratio near measured clear skies. Fog matches the horizon. After dark, exposure adapts, moonlight takes over, and airglow keeps the sky deep blue. The sun follows an artistic summer path (sunrise 06:00, sunset 20:30, 60° at noon), not a location-based study.
- **Interior:** a radiance probe captured from the middle of the room lights and reflects interior surfaces with the room itself (daylight through the glazing, luminaires, finishes) rather than the open sky. It is captured twice per change to approximate a second bounce. Downlights are spot lights; the back-wall cove and toe-kick are rectangular area lights. The interior view meters about +2/3 stop brighter, as a photographer would.
- **Mirror:** High and Ultra render a true planar reflection; Lite uses a probe-lit polished surface.

Materials come from 18 CC0 photo-scanned PBR sets from [Poly Haven](https://polyhaven.com/) (albedo, OpenGL normal, and packed AO/roughness/metalness), plus baked powder-coat, brushed-steel, and knurl detail maps. `public/textures/sources.json` records each set's authors, physical size, and role; `scripts/build-textures.py` (Python 3, Pillow, NumPy) reproduces them. Every model carries UVs measured in feet, so each texture appears at its true physical scale. The ground blends two scales of its scan with noise so it never visibly repeats. Textures stream in after the scene appears, with a progress indicator. The library is about 17 MB of WebP; only the sets a view needs are downloaded, and the live view loads 1K copies of the four 2K scans (about 7.5 MB less).

Models are procedural and batched: each equipment item or architectural assembly is merged per material into a few draw calls and shared by every placed copy. Trees use alpha-tested leaf cards with crown-bent normals and daylight-scaled translucency; grass and foliage are instanced. Footprint tests keep every equipment model inside the planning envelope the floor-plan collision rules use; a racked Olympic bar is the one deliberate exception, overhanging its uprights into the rack's published side clearance as on real racks.

These remain procedural concept models, not manufacturer-verified CAD or photographic scans of Fury products. Equipment is generic. Clear glazing is drawn as thin float glass over the room behind it (Fresnel reflection, nothing blurred); tinted sauna glass and water use physically based transmission, not traced caustics. Lights do not simulate certified photometry, and screen-space GI only bounces light that is on screen. Pre-rendered stills accumulate 256 frames at Ultra quality from a 1.5× supersampled render, but use the same real-time renderer; they are not path traced (a Blender Cycles renderer is reserved behind the same interface for when CAD models exist).

The three.js chunk is about 1.6 MB minified, 480 kB gzipped, and loads only with the scene: React Three Fiber is pointed at three's WebGPU build, so the classic WebGL renderer is not bundled. The app shell (app code, React, and CSS) is about 430 kB minified, 130 kB gzipped, and paints the configurator before three.js or jsPDF arrive.

Smoothness and reliability:

- **Nothing runs at rest.** three's own animation loop is stopped; frames are drawn only on demand and for the settle window. Sun shadows re-render only when something changes, not on every settle frame. Sub-pixel camera damping no longer extends the settle window.
- **No shader compiles on common toggles.** Lights that come and go (moonlight, interior luminaires, sauna heaters) stay mounted at zero intensity, and foliage, grass, ground, and studio floor materials are kept for the session, so switching lights, Day/Night, packages, or surroundings reuses compiled shaders instead of stalling. On WebGPU, instanced trees, hedges, and grass read their placements from vertex attributes, so every copy shares its material's shader rather than compiling one per mesh. (A 20↔40 ft change still recompiles lit materials once, because the larger unit has more downlights.)
- **Loading is always visible.** A first visit shows staged progress (downloading the 3D engine, starting the renderer, preparing materials and lighting) until the scene has drawn its first frame, while the configuration panel already works. Changes that rebuild much of the scene (size, product, surroundings, quality) show "Updating the 3D view" a frame before the work starts, and materials streaming in show a progress bar. Their motion is transform-only, so it keeps animating while the browser compiles shaders.
- **Textures decode off the main thread** where the browser supports it, retry on network errors (a whole set that fails tries again after growing pauses, then textures every surface that was waiting), and show neutral stand-ins until they arrive; a failed texture never leaves the progress indicator stuck.
- **Recovery.** If the GPU device or WebGL context is lost, the scene rebuilds its renderer and textures (up to three times) instead of freezing. If the 3D code fails to download, configuration, pricing, and the floor plan keep working with a message in place of the scene; any other unexpected error shows a reload screen instead of a blank page, and the design survives the reload in the page's link.

No 60 fps or low-end mobile performance claim has been validated on physical hardware; the automatic step-down is a safeguard, not a benchmark.

## Verification

Vitest covers presets at both sizes, family transitions and heights, Container openings, independent Studio add-ons, custom inquiries, wall/entry/collision constraints, quote-only pricing, schema v1 migration, share validation, storage failure, undo/redo, real PDF generation for both families, demand-render invalidation, demand-loop frame bookkeeping, on-demand shadow refresh, texture retry and off-thread decoding, share-link throttling and pasted links, saved-build preservation, model part keys, the sun path and sky model, quality and backend selection, material streaming progress, every equipment model staying inside its planning footprint, valid batched geometry, and both product shells staying inside their nominal envelopes for every opening and length. It also covers schema v3 migrations, render-key stability and relevance (what each layer can and cannot show), full coverage of the layer enumeration, still camera poses, and Day/Night. A browser smoke test (`npm run smoke` in `render/`) checks that the first still shows before any 3D code loads, that angles swap, that a 3D failure leaves the stills working, and that the live fallback and 360 view work. The batch renderer's seam and relevance audits need a GPU. These are not substitutes for real-device performance testing, accessibility audits, or manufacturer review.

## Before commercial launch

The supplied six-phase roadmap remains the product direction, not a claim that every phase has shipped. The current release is a self-contained frontend foundation plus useful interior-planning and decision tools. Production integrations are deliberately absent rather than simulated.

1. **Verified product data:** replace procedural geometry with approved CAD-derived glTF, confirm shell and add-on dimensions, and obtain licensed equipment assets and manufacturer clearances.
2. **Commercial configuration:** approved prices, taxes, regional delivery/foundation assumptions, deposit/refund terms, finance partner disclosures, production lead times, and warranty/specification copy.
3. **Backend and operations:** provision the intended Supabase project, authentication/RLS, versioned pricing/catalog administration, server-side quote validation, transactional email, CRM routing, and a rep dashboard. Confirm the recipient and retention policy before collecting leads.
4. **Payments:** use server-created, approved-price Stripe Checkout sessions, signed webhook handling, idempotency, and refund handling; never trust the client estimate as a charge amount.
5. **Visual and spatial services:** run the first full stills batch on a GPU host, then validated glTF/USDZ export, physical-device AR/VR, actual first-person navigation, path-traced stills (Cycles) from CAD-derived models, and share-preview images.
6. **Site and AI layers:** licensed map/parcel data, sourced zoning guidance, calibrated geospatial shadows, privacy controls for uploaded photos, and a model-backed assistant restricted to validated configuration tools and approved source documents.
7. **Release gate:** desktop/mobile E2E and accessibility audits, field-tested PDF and sharing, renderer fallback testing, observability with appropriate consent, and legal/product sign-off.

The configurator does **not** certify construction, safe installation, site fit, zoning, engineering, delivery feasibility, or equipment suitability. All such decisions require qualified local review.
