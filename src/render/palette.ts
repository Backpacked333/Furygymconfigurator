import { DoubleSide } from 'three'
import { material, type MaterialSpec } from './materials'

/**
 * The material vocabulary of the scene. Values follow measured PBR ranges (albedo, roughness,
 * IOR) for each real material, with photo-scanned detail from the bundled texture library.
 * `interior` surfaces are lit by the captured room probe instead of the open sky.
 */
const m = (spec: MaterialSpec) => material(spec)

export const palette = {
  // Metals ---------------------------------------------------------------------------------
  /** Powder-coated steel (frames, uprights, shells): fine orange-peel relief. */
  powder: (color: string, interior = true, roughness = 0.62) =>
    m({ set: 'powder_coat', color, roughness, normalScale: 0.35, interior }),
  /** Exterior architectural powder coat, a touch glossier with a clear finish. */
  shell: (color: string) =>
    m({
      set: 'powder_coat',
      color,
      roughness: 0.48,
      normalScale: 0.3,
      clearcoat: 0.75,
      clearcoatRoughness: 0.16,
    }),
  brushed: (interior = true, color = '#d7d9da') =>
    m({ set: 'brushed_metal', color, metalness: 1, roughness: 1, interior }),
  polished: (interior = true) => m({ color: '#e6e8ea', metalness: 1, roughness: 0.12, interior }),
  knurl: () => m({ set: 'knurling', color: '#c6c9cb', metalness: 1, roughness: 1, interior: true }),
  anodized: (color = '#2b2e2c', interior = false) =>
    m({ set: 'brushed_metal', color, metalness: 0.85, roughness: 1.15, interior }),
  zinc: () => m({ color: '#9ea3a4', metalness: 1, roughness: 0.42, interior: true }),
  // Polymers ---------------------------------------------------------------------------------
  rubber: (color = '#232424', interior = true) =>
    m({ set: 'rubberized_track', color, roughness: 0.92, normalScale: 0.6, interior }),
  vinyl: (color: string) =>
    m({
      set: 'leather_white',
      color,
      roughness: 0.78,
      normalScale: 0.7,
      sheen: 0.4,
      sheenRoughness: 0.45,
      sheenColor: '#6b6f6c',
      interior: true,
    }),
  fabric: (color: string) =>
    m({
      set: 'rough_linen',
      color,
      roughness: 1,
      sheen: 1,
      sheenRoughness: 0.7,
      sheenColor: color,
      interior: true,
    }),
  plastic: (color: string, roughness = 0.42) => m({ color, roughness, interior: true }),
  nylon: (color = '#1c1d1d') => m({ color, roughness: 0.8, interior: true }),
  // Wood --------------------------------------------------------------------------------------
  oak: (interior = true, color = '#ffffff') =>
    m({ set: 'oak_veneer_01', color, roughness: 0.9, interior }),
  oakOiled: () =>
    m({
      set: 'oak_veneer_01',
      color: '#f2e6d8',
      roughness: 0.8,
      clearcoat: 0.5,
      clearcoatRoughness: 0.35,
      interior: true,
    }),
  hinoki: () => m({ set: 'hinoki_planks', color: '#fff4e6', roughness: 1, interior: true }),
  teak: (interior = false) =>
    m({ set: 'teak_veneer', color: '#e7d2bd', roughness: 0.95, interior }),
  // Mineral -----------------------------------------------------------------------------------
  /** Eggshell-painted drywall: only a whisper of the scanned plaster relief survives the paint. */
  paint: (color = '#f2efe9') =>
    m({ set: 'beige_wall_001', color, roughness: 0.92, normalScale: 0.22, interior: true }),
  concrete: (interior = false) => m({ set: 'concrete_wall_001', roughness: 1, interior }),
  // Light and glass ---------------------------------------------------------------------------
  glass: () =>
    m({
      color: '#ffffff',
      transmission: 1,
      roughness: 0.03,
      ior: 1.52,
      thickness: 0.03,
      attenuationColor: '#cfe6dc',
      attenuationDistance: 1.2,
      specularIntensity: 1,
      side: DoubleSide,
    }),
  tintedGlass: () =>
    m({
      color: '#ffffff',
      transmission: 1,
      roughness: 0.04,
      ior: 1.52,
      thickness: 0.03,
      attenuationColor: '#a3876a',
      attenuationDistance: 0.25,
      interior: true,
    }),
  emitter: (color: string, intensity: number) =>
    m({ color: '#000000', emissive: color, emissiveIntensity: intensity, roughness: 1 }),
  screen: (color = '#0c100f') =>
    m({
      color,
      roughness: 0.12,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      interior: true,
    }),
  black: () => m({ color: '#0b0c0c', roughness: 0.9, interior: true }),
}
