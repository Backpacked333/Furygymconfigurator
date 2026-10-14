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

Open the URL printed by Vite. If you do not use nvm, install Node 24 and run the npm commands directly. No environment variables, API keys, database, or third-party accounts are required. Fonts, models, materials, and scripts are bundled or generated locally; there are no remote model or font requests.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run preview
```

`npm run format` applies Prettier. CI runs formatting, ESLint, TypeScript, Vitest, and the production build. There are no custom pre-commit hooks. Production output is `dist/`, suitable for Vercel, Netlify, Cloudflare Pages, or another static host. Configure `npm run build` as the build command and `dist` as the output directory; serve the app over HTTPS for clipboard sharing. Do not expose Vite's development server as the public production service.

## What works

| Area          | Implemented                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products      | Two families, 20-/40-foot footprints, family-specific nominal heights and source-linked features                                                                        |
| Exterior      | Container opening previews and integrated finish request; independent Studio front deck, gazebo, rooftop deck, stairs; four concept colors                              |
| Visualization | Exterior orbit, fixed-position interior look-around, three environments, time of day, lights, dimensions, camera reset, optional auto-rotation                          |
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
- **Photo mode:** expands the scene and downloads a rasterized PNG at the current canvas resolution. It is not 4K path tracing.

## Configuration architecture

One validated, versioned `Config` object drives the scene, layout, quote checklist, share payload, and PDF. `src/lib/config.ts` owns the Zod schema, planning equipment, presets, validation rules, unit conversions, and quote semantics. `src/lib/products.ts` owns the sourced product facts. Never add prices separately in a component or PDF.

```text
src/
  App.tsx                     Workspace, dialogs, camera modes, history shortcuts
  components/
    ConfigPanel.tsx           Four-step selection interface
    Scene.tsx                 Camera, light, environment, dimensions, graphics fallback
    RenderEffects.tsx         High-mode ambient occlusion, filmic output, matching captures
    StudioModel.tsx           Detailed parametric shell, glazing, mirror, outdoor structures
    SurfaceMaterial.tsx       Shared local color/bump textures and material profiles
    Landscape.tsx             Instanced foliage, grasses, gravel, and courtyard hardscape
    Equipment.tsx             Procedural generic equipment
    FloorPlan.tsx             Accessible SVG floor-plan editor
    Dialogs.tsx               Saved comparisons, quote checklist, sharing, brief form
    Modal.tsx                 Native dialog lifecycle
  lib/
    config.ts                 Domain model, rules, estimates, URLs, persistence
    products.ts               Official product facts, sources, and published choices
    useConfig.ts              Reducer-backed history and automatic draft
    export.ts                 On-demand PDF generation and downloads
    config.test.ts            Domain, storage, history, and PDF regression tests
    visuals.ts                Deterministic surface generation and continuous lighting curves
    visuals.test.ts           Material and lighting regression tests
```

Dimensions use **feet internally**, with x along unit length and z along depth; the front is positive z. Both families are 20/40 × 8 feet, with heights from the product table above. The floor plan uses a conservative concept usable envelope and reserves a planned entry aligned to the chosen opening. Only the roll-up width is published; other opening widths/positions and all deck/gazebo/stair geometry are illustrative. Collision checks cover equipment footprints and a small placement buffer, **not manufacturer safety clearances, electrical requirements, accessibility, structural loading, or permitted occupancy**. Dashed envelopes are illustrative guidance and can overlap.

Rules:

- Studio add-ons can be selected individually or together, as the Studio page describes. The former automatic gazebo/deck and stairs/roof dependencies were prototype assumptions, not published engineering rules, and have been removed. All combinations still require support/access/engineering review; the model is not certification.
- Switching to Containers clears Studio-only additions, timber accents, and custom Studio requests while preserving shared finishes, length, and equipment. Switching families resets opening-specific selections. Undo restores the previous state. A change that obstructs the new planned entry is blocked until equipment is rearranged.
- Concept templates keep the chosen product family but reset the reference footprint to 20 feet after confirmation.
- Invalid, unsupported, oversized, duplicate-ID, or geometrically invalid shared configurations are rejected.
- Schema `v: 2` adds `family`, `containerOpening`, `integratedFinish`, and `studioLayout`. Legacy `v: 1` links/drafts/saved builds migrate automatically to Studios and are fully revalidated. Existing selections are preserved; old conceptual prices are not. Unsupported versions are rejected. This is the implemented app contract, not a roadmap example.

### Local data and sharing

The URL fragment `#c=…` contains the entire LZ-string-compressed configuration. It updates with edits and is not sent in HTTP requests to the static host. Anyone with the full link can read the configuration. There is no short-link service, authentication, cross-device account, or automatic social-preview image. A link needs a running deployment of this app; localhost and session-preview links are not permanent public links.

`fury-draft-v1` and `fury-builds-v1` remain the only localStorage keys to preserve existing drafts and saved builds; their payloads migrate to schema v2. A valid URL configuration takes precedence over the draft. Storage failure does not prevent configuration or file export; named-save failures show a message. Clearing browser storage removes local drafts and saved builds, so export important designs.

PDF generation loads jsPDF only when needed. Scene capture is omitted in floor-plan mode or when graphics are unavailable; the floor-plan drawing and other brief sections still export. Core PDF fonts target Latin-script text. No analytics or session replay is installed.

### Rendering and performance

Three.js/React Three Fiber and PDF generation use separate bundles. Rendering is demand-driven except during camera animation and auto-rotation. High mode uses soft directional/contact shadows, screen-space ambient occlusion, a 512-pixel planar mirror reflection, a 256-pixel local lighting environment, and device pixel ratio capped at 2. Lite removes shadows and postprocessing, substitutes an environment-mapped mirror, lowers the lighting environment to 64 pixels, reduces foliage/grass instances, and uses device pixel ratio 1. Narrow screens initially select Lite; users can override it. This is viewport-based selection, not GPU/network benchmarking.

The scene uses six shared, deterministic 256-pixel color/bump texture pairs for cedar, oak, rubber, stone, plaster, and powder-coated metal. Foliage, planting, and gravel use instancing rather than one mesh per leaf. Daylight intensity and warmth transition continuously across the time slider. Architectural detailing includes beveled shell edges, separately glazed bays, door hardware, slatted ceilings, ventilation grilles, luminaires, mirror seams, and equipment fasteners. All assets and textures are generated locally; there are no remote HDRI, model, or texture requests.

These remain procedural concept models, not manufacturer-verified CAD or photographic scans. Glass uses layered transparency and environment reflections, not physically traced refraction. High mode's wall mirror renders the current scene; Lite's mirror is only an approximation. Lights do not simulate certified photometry or baked global illumination. Photo and PDF exports use the same current-view renderer, not a separate offline/path-traced pipeline.

The Three.js vendor chunk exceeds Vite's 500 kB advisory threshold. It is loaded for the scene, not PDF generation. No 60 fps or low-end mobile performance claim has been validated on physical hardware.

## Verification

Vitest covers presets at both sizes, family transitions and heights, Container openings, independent Studio add-ons, custom inquiries, wall/entry/collision constraints, quote-only pricing, schema v1 migration, share validation, storage failure, undo/redo, real PDF generation for both families, deterministic surface textures, continuous lighting curves, and demand-render invalidation. These are not substitutes for browser interaction tests, real-device performance testing, accessibility audits, or manufacturer review. No screenshot-diff or browser E2E suite is included yet.

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
