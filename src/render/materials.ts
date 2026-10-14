import {
  Color,
  FrontSide,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  type ColorRepresentation,
  type Side,
  type Texture,
} from 'three'
import { textureProgress } from './progress'

/**
 * Physical sizes (feet per tile) of the bundled CC0 Poly Haven scans plus three baked
 * procedural detail sets. See public/textures/sources.json and scripts/build-textures.py.
 */
export const TEXTURE_SETS = {
  rubber_tiles: { size: 6.562 },
  laminate_floor_02: { size: 5.577 },
  granite_tile_04: { size: 6.562 },
  beige_wall_001: { size: 9.843 },
  oak_veneer_01: { size: 6.004 },
  hinoki_planks: { size: 6.201 },
  teak_veneer: { size: 3.281 },
  leather_white: { size: 0.984 },
  rough_linen: { size: 0.889 },
  rubberized_track: { size: 3.2 },
  painted_metal_shutter: { size: 6.562 },
  concrete_pavement: { size: 5.906 },
  leafy_grass: { size: 6.562 },
  dry_ground_01: { size: 13.123 },
  clean_pebbles: { size: 6.562 },
  bark_platanus: { size: 4.921 },
  concrete_slab_wall: { size: 7.546 },
  concrete_wall_001: { size: 4.921 },
  powder_coat: { size: 0.25, detailOnly: true },
  brushed_metal: { size: 1.5, detailOnly: true, metallic: true },
  knurling: { size: 0.1, detailOnly: true, metallic: true },
} as const satisfies Record<string, { size: number; detailOnly?: boolean; metallic?: boolean }>
export type TextureSet = keyof typeof TEXTURE_SETS

export type Maps = { albedo?: Texture; normal: Texture; arm: Texture }

export type MaterialSpec = {
  set?: TextureSet
  color?: ColorRepresentation
  roughness?: number
  metalness?: number
  normalScale?: number
  aoIntensity?: number
  envIntensity?: number
  /** Lit by the captured interior radiance probe instead of the open sky. */
  interior?: boolean
  clearcoat?: number
  clearcoatRoughness?: number
  sheen?: number
  sheenRoughness?: number
  sheenColor?: ColorRepresentation
  transmission?: number
  ior?: number
  thickness?: number
  attenuationColor?: ColorRepresentation
  attenuationDistance?: number
  specularIntensity?: number
  emissive?: ColorRepresentation
  emissiveIntensity?: number
  transparent?: boolean
  opacity?: number
  side?: Side
  depthWrite?: boolean
}

let anisotropy = 8
export function setMaxAnisotropy(value: number) {
  anisotropy = Math.max(1, Math.min(16, value))
}

// --- Load tracking ------------------------------------------------------------

export { textureProgress }

const loader = new TextureLoader()
const base = `${import.meta.env.BASE_URL}textures/`
const sets = new Map<TextureSet, Promise<Maps>>()
const ready = new Map<TextureSet, Maps>()

function configure(texture: Texture, size: number, color: boolean) {
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.repeat.set(1 / size, 1 / size)
  texture.colorSpace = color ? SRGBColorSpace : NoColorSpace
  texture.anisotropy = anisotropy
  texture.needsUpdate = true
  return texture
}

function load(set: TextureSet): Promise<Maps> {
  let pending = sets.get(set)
  if (pending) return pending
  const info = TEXTURE_SETS[set] as { size: number; detailOnly?: boolean }
  const names = info.detailOnly ? ['normal', 'arm'] : ['albedo', 'normal', 'arm']
  textureProgress.update(names.length, 0)
  pending = Promise.all(
    names.map((name) =>
      loader.loadAsync(`${base}${set}/${name}.webp`).then((texture) => {
        textureProgress.update(0, 1)
        return [name, configure(texture, info.size, name === 'albedo')] as const
      }),
    ),
  ).then((entries) => {
    const maps = Object.fromEntries(entries) as Maps
    ready.set(set, maps)
    return maps
  })
  sets.set(set, pending)
  return pending
}

// --- Material library ----------------------------------------------------------

const materials = new Map<string, MeshStandardMaterial>()
const interiorMaterials = new Set<MeshStandardMaterial>()
let interiorEnvironment: Texture | null = null
export type MaterialChange = 'textures' | 'probe'
const changeListeners = new Set<(change: MaterialChange) => void>()

/** Notified when textures arrive or the interior probe changes, so demand rendering redraws. */
export function onMaterialsChanged(listener: (change: MaterialChange) => void) {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}
function changed(change: MaterialChange) {
  changeListeners.forEach((listener) => listener(change))
}

function applyMaps(material: MeshStandardMaterial, spec: MaterialSpec, maps: Maps) {
  const info = TEXTURE_SETS[spec.set!] as { metallic?: boolean }
  if (maps.albedo) material.map = maps.albedo
  material.normalMap = maps.normal
  material.roughnessMap = maps.arm
  material.aoMap = maps.arm
  if (info.metallic) material.metalnessMap = maps.arm
  material.needsUpdate = true
}

export function material(spec: MaterialSpec): MeshStandardMaterial {
  const key = JSON.stringify(spec)
  const existing = materials.get(key)
  if (existing) return existing
  const physical =
    spec.clearcoat !== undefined ||
    spec.sheen !== undefined ||
    spec.transmission !== undefined ||
    spec.specularIntensity !== undefined
  const m = physical ? new MeshPhysicalMaterial() : new MeshStandardMaterial()
  m.color = new Color(spec.color ?? '#ffffff')
  m.roughness = spec.roughness ?? (spec.set ? 1 : 0.6)
  m.metalness = spec.metalness ?? 0
  m.normalScale = new Vector2(spec.normalScale ?? 1, spec.normalScale ?? 1)
  m.aoMapIntensity = spec.aoIntensity ?? 1
  m.envMapIntensity = spec.envIntensity ?? 1
  m.side = spec.side ?? FrontSide
  m.transparent = spec.transparent ?? false
  m.opacity = spec.opacity ?? 1
  m.depthWrite = spec.depthWrite ?? true
  if (spec.emissive) {
    m.emissive = new Color(spec.emissive)
    m.emissiveIntensity = spec.emissiveIntensity ?? 1
  }
  if (m instanceof MeshPhysicalMaterial) {
    m.clearcoat = spec.clearcoat ?? 0
    m.clearcoatRoughness = spec.clearcoatRoughness ?? 0.1
    m.sheen = spec.sheen ?? 0
    m.sheenRoughness = spec.sheenRoughness ?? 0.6
    if (spec.sheenColor) m.sheenColor = new Color(spec.sheenColor)
    m.transmission = spec.transmission ?? 0
    m.ior = spec.ior ?? 1.5
    m.thickness = spec.thickness ?? 0
    if (spec.attenuationColor) m.attenuationColor = new Color(spec.attenuationColor)
    m.attenuationDistance = spec.attenuationDistance ?? Infinity
    m.specularIntensity = spec.specularIntensity ?? 1
  }
  if (spec.set) {
    const maps = ready.get(spec.set)
    if (maps) applyMaps(m, spec, maps)
    else
      load(spec.set).then((loaded) => {
        applyMaps(m, spec, loaded)
        changed('textures')
      })
  }
  if (spec.interior) {
    interiorMaterials.add(m)
    if (interiorEnvironment) m.envMap = interiorEnvironment
  }
  materials.set(key, m)
  return m
}

/** Point every interior material at the latest captured interior radiance probe. */
export function setInteriorEnvironment(texture: Texture | null) {
  interiorEnvironment = texture
  interiorMaterials.forEach((m) => {
    // Swapping between same-format probe textures only rebinds; adding or removing one recompiles.
    if (!m.envMap !== !texture) m.needsUpdate = true
    m.envMap = texture
  })
  changed('probe')
}

export function isInteriorMaterial(m: unknown) {
  return interiorMaterials.has(m as MeshStandardMaterial)
}

/** Loaded maps of a set, for custom node materials (shared with the library's materials). */
export function textureMaps(set: TextureSet) {
  return load(set)
}

/** Warm the cache for sets the first view needs, before meshes ask for them. */
export function preload(list: TextureSet[]) {
  return Promise.all(list.map(load))
}
