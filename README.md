# FURY / S-Series Studio

A laptop-first, architectural-style configurator for a personal fitness and recovery studio, designed around 12–16-inch displays (roughly 1280–1728 CSS pixels wide). Explore a procedural 3D studio, configure its shell and outdoor spaces, arrange equipment in a collision-aware floor plan, and take away a shareable design and PDF brief. Mobile has a basic responsive fallback but is not the primary experience.

**This is a working concept configurator, not a live purchasing system.** Prices are illustrative, geometry is not manufacturer CAD, and equipment and working clearances are generic. No quotes, customer details, payments, or sales emails are sent anywhere.

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
| Studio        | Independent 20- and 40-foot footprints, four finishes, cedar accents, mirror wall, three floors                                                                         |
| Outdoor       | Front terrace, pergola, rooftop deck, staircase, automatic structural-option dependencies                                                                               |
| Visualization | Exterior orbit, fixed-position interior look-around, three environments, time of day, lights, dimensions, camera reset, optional auto-rotation                          |
| Interior      | Strength, recovery, movement, cardio, and empty presets; ten generic equipment items                                                                                    |
| Floor plan    | Pointer dragging, quarter-foot snapping, rotation, removal, entry and boundary protection, collision rejection, visible working-space envelopes                         |
| Decisions     | Itemized illustrative estimates, financing-assumption calculator, 50-step undo/redo, signature starter builds                                                           |
| Persistence   | Automatic local draft, up to 12 named local builds, two-build comparison, versioned compressed share URLs                                                               |
| Deliverables  | Configuration JSON, current-view PNG, multipage PDF with scene image when available, floor plan, estimate, notes, and share link                                        |
| Access        | Responsive controls, touch interaction, keyboard camera and floor-plan controls, labeled options, focus-trapped dialogs, reduced-motion camera transitions, 2D fallback |

### Controls

- **Exterior:** drag to orbit, pinch or scroll to zoom. Focus the scene for arrow keys and `+`/`−`.
- **Interior:** drag or use arrows to look around from a fixed point inside the studio. This is not a collision-enabled walk-through.
- **Floor plan:** drag an item; arrows move it 3 inches, Shift+arrows move it 1 foot, `R` rotates, Delete/Backspace removes. Invalid moves are rejected with an explanation. Rotation is 0° or 90°.
- **History:** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes. Changing size preserves selections, and downsizing is blocked if current equipment would no longer fit.
- **Photo mode:** expands the scene and downloads a rasterized PNG at the current canvas resolution. It is not 4K path tracing.

## Configuration architecture

One validated, versioned `Config` object drives the scene, layout, estimate, share payload, and PDF. `src/lib/config.ts` owns the Zod schema, catalog, presets, validation rules, unit conversions, and illustrative price model. Update prices centrally, never in a component or PDF separately.

```text
src/
  App.tsx                     Workspace, dialogs, camera modes, history shortcuts
  components/
    ConfigPanel.tsx           Four-step selection interface
    Scene.tsx                 Camera, light, environment, dimensions, graphics fallback
    StudioModel.tsx           Parametric shell and outdoor structures
    Equipment.tsx             Procedural generic equipment
    FloorPlan.tsx             Accessible SVG floor-plan editor
    Dialogs.tsx               Saved comparisons, estimates, sharing, brief form
    Modal.tsx                 Native dialog lifecycle
  lib/
    config.ts                 Domain model, rules, estimates, URLs, persistence
    useConfig.ts              Reducer-backed history and automatic draft
    export.ts                 On-demand PDF generation and downloads
    config.test.ts            Domain, storage, history, and PDF regression tests
```

Dimensions use **feet internally**, with x along studio length and z along depth; the front is positive z. The outer studio is 20/40 × 8 × 10 feet. The floor plan uses a conservative usable envelope inside the shell and reserves the central entry. Collision checks cover equipment footprints and a small placement buffer, **not manufacturer safety clearances, electrical requirements, accessibility, structural loading, or permitted occupancy**. Dashed envelopes are illustrative guidance and can overlap.

Rules:

- A pergola requires a front terrace. Enabling it adds the terrace; removing the terrace removes the pergola.
- Stairs require a rooftop deck. Enabling stairs adds the rooftop; removing the rooftop removes stairs.
- Roof decks without stairs are permitted for exploration, with an explicit access warning.
- Invalid, unsupported, oversized, duplicate-ID, or geometrically invalid shared configurations are rejected.
- Schema `v: 1` is this application's share contract; it is not compatible with the aspirational `v: 2` example in the source roadmap.

### Local data and sharing

The URL fragment `#c=…` contains the entire LZ-string-compressed configuration. It updates with edits and is not sent in HTTP requests to the static host. Anyone with the full link can read the configuration. There is no short-link service, authentication, cross-device account, or automatic social-preview image. A link needs a running deployment of this app; localhost and session-preview links are not permanent public links.

`fury-draft-v1` and `fury-builds-v1` are the only localStorage keys. A valid URL configuration takes precedence over the draft. Storage failure does not prevent configuration or file export; named-save failures show a message. Clearing browser storage removes local drafts and saved builds, so export important designs.

PDF generation loads jsPDF only when needed. Scene capture is omitted in floor-plan mode or when graphics are unavailable; the floor-plan drawing and other brief sections still export. Core PDF fonts target Latin-script text. No analytics or session replay is installed.

### Rendering and performance

Three.js/React Three Fiber and PDF generation use separate bundles. Rendering is demand-driven except during camera animation and auto-rotation. High mode uses shadows and a capped pixel ratio; Lite removes shadows and uses device pixel ratio 1. Narrow screens initially select Lite; users can override it. This is viewport-based selection, not GPU/network benchmarking. Equipment, materials, and trees are procedural; no licensed model assets or external HDRIs are required.

The Three.js vendor chunk exceeds Vite's 500 kB advisory threshold. It is loaded for the scene, not PDF generation. No 60 fps or low-end mobile performance claim has been validated on physical hardware.

## Verification

Vitest covers every preset at both sizes, add-on transition combinations, wall/entry/collision constraints, equipment placement, estimate scaling, financing edge cases, share validation, storage failure, undo/redo limits, and real PDF generation. These are not substitutes for browser interaction tests, real-device performance testing, accessibility audits, or manufacturer review. No screenshot-diff or browser E2E suite is included yet.

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
