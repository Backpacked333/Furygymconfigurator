import type { TextureSet } from '../render/textureSets'
import type { Config, EnvironmentId, PlacedItem } from './config'

/**
 * The scanned material sets a design's scene is made from, read off the design alone: no part is
 * built and nothing of three.js is loaded, so the 360° view can start downloading them as soon as
 * the visitor shows intent to open it (src/prototype/liveWarmup.ts), before its scene exists.
 *
 * A table, kept in step with the builders by a parity test (designTextures.test.tsx), which
 * renders the scene for a matrix of designs and compares what it downloads with this list. Outside
 * src/render, so an edit here leaves the render version (scripts/render-version.ts) alone: the list
 * only decides what downloads early, never what a still looks like. A set missing from it costs
 * the live view only time, as the scene asks for it when it is built.
 */

/**
 * In every unit: the powder-coated shell and frames, and brushed steel trim. The tables below
 * leave these two out.
 */
const UNIT: readonly TextureSet[] = ['powder_coat', 'brushed_metal']

/** The room's lining (architecture.ts liner, slatCeiling). */
const LINING: Record<Config['interiorStyle'], readonly TextureSet[]> = {
  gallery: ['beige_wall_001'],
  slatted: ['beige_wall_001', 'oak_veneer_01'],
  timber: ['japanese_cedar_planks'],
  birch: ['plywood'],
}

/** The floor (architecture.ts floor). */
const FLOOR: Record<Config['flooring'], readonly TextureSet[]> = {
  rubber: ['rubber_tiles'],
  oak: ['laminate_floor_02'],
  stone: ['granite_tile_04'],
  concrete: ['concrete_floor_worn_001'],
}

/** Each catalog item (equipment.ts). */
const EQUIPMENT: Record<PlacedItem['sku'], readonly TextureSet[]> = {
  rack: ['knurling', 'rubberized_track'],
  halfrack: ['knurling', 'rubberized_track'],
  trainer: ['knurling', 'rubberized_track'],
  weights: ['knurling', 'rubberized_track'],
  bench: ['leather_white', 'rubberized_track'],
  bike: ['leather_white', 'rubberized_track'],
  airbike: ['leather_white', 'rubberized_track'],
  medball: ['rubberized_track'],
  treadmill: ['rubberized_track'],
  plyo: ['plywood'],
  sauna: ['concrete_wall_001', 'hinoki_planks', 'oak_veneer_01'],
  plunge: ['oak_veneer_01'],
  lounge: ['oak_veneer_01', 'rough_linen'],
  mat: ['rough_linen', 'rubberized_track'],
  reformer: ['leather_white', 'oak_veneer_01'],
  shelf: ['oak_veneer_01', 'rough_linen', 'rubberized_track'],
}

/**
 * Each setting (Landscape.tsx, Surroundings.tsx, buildings.ts): its ground, paving, buildings,
 * planters and trees' bark. The Studio backdrop has none: it shows its plain floor alone.
 */
const SETTING: Record<EnvironmentId, readonly TextureSet[]> = {
  residences: [
    'herringbone_pavement',
    'concrete_wall_001',
    'red_brick_03',
    'white_stucco',
    'japanese_cedar_planks',
    'granite_tile_04',
    'dry_ground_01',
    'teak_veneer',
    'rough_linen',
    'bark_platanus',
  ],
  campus: [
    'concrete_pavement',
    'concrete_wall_001',
    'white_stucco',
    'clean_pebbles',
    'granite_tile_04',
    'dry_ground_01',
    'bark_platanus',
  ],
  backyard: [
    'leafy_grass',
    'concrete_pavement',
    'white_stucco',
    'japanese_cedar_planks',
    'teak_veneer',
    'bark_platanus',
  ],
  courtyard: [
    'leafy_grass',
    'concrete_pavement',
    'concrete_slab_wall',
    'concrete_wall_001',
    'clean_pebbles',
    'dry_ground_01',
    'bark_platanus',
  ],
  desert: [
    'dry_ground_01',
    'concrete_pavement',
    'concrete_slab_wall',
    'concrete_wall_001',
    'clean_pebbles',
    'bark_platanus',
  ],
  studio: [],
}

/**
 * Every set the scene for `c` asks for, each once: the unit's first, then its equipment's, then the
 * setting's, the order in which they are worth having.
 */
export function textureSetsFor(c: Config): TextureSet[] {
  const studio = c.family === 'studio'
  const sets: TextureSet[] = [...UNIT, ...LINING[c.interiorStyle], ...FLOOR[c.flooring]]
  if (!studio && c.containerOpening === 'roll-up') sets.push('painted_metal_shutter')
  // Teak deck boards and timber (addons.ts); the Container's stairs have steel treads.
  if (c.accent || c.addons.gazebo || c.addons.deck || c.addons.roof || (studio && c.addons.stairs))
    sets.push('teak_veneer')
  // The Container's roof deck is framed in cedar.
  if (!studio && c.addons.roof) sets.push('japanese_cedar_planks')
  // Stepping stones to the Container's deck; the stairs' ground pad.
  if ((!studio && c.addons.deck) || c.addons.stairs) sets.push('concrete_wall_001')
  for (const item of c.items) sets.push(...EQUIPMENT[item.sku])
  sets.push(...SETTING[c.environment])
  return [...new Set(sets)]
}
