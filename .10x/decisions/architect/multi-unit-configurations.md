# Principal Architect — multi-unit-configurations

## [DISCOVERED] Single-unit assumptions that a multi-unit design must replace

| Area       | File                                  | Assumption                                                                                              |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Domain     | lib/config.ts                         | One `length`; equipment `x∈[-20,20]`, `z∈[-4,4]` in one unit frame; one entry; `studioLayout` text only |
| Shells     | render/architecture.ts                | `studioShell/containerShell/…(c)` build one unit centred at origin (good: local-frame, composable)      |
| Add-ons    | render/addons.ts                      | Deck/pergola/roof/stairs positioned against one unit; `STAIR.start` hard-coded                          |
| Scene      | components/StudioModel.tsx            | Renders one shell + interior + add-ons; `useParts` caches by string key                                 |
| Camera     | components/Scene.tsx                  | Exterior framing from `c.length`; interior viewpoint fixed at `(L/2-2.2, 5.8, 1.4)`                     |
| Lighting   | InteriorLights.tsx, InteriorProbe.tsx | One room, one radiance probe                                                                            |
| Floor plan | components/FloorPlan.tsx              | SVG viewBox sized to one `length × 8` box, one entry zone                                               |
| Export     | lib/export.ts                         | One floor plan drawing in the PDF                                                                       |

## Design — to be decided in brainstorming
