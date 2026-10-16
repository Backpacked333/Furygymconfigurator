import {
  Color,
  CustomBlending,
  DataTexture,
  DataUtils,
  FrontSide,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  UnsignedByteType,
  Vector2,
  type ColorRepresentation,
  type ColorSpace,
  type Side,
} from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { float, normalView, pmremTexture, positionViewDirection } from 'three/tsl'
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
  red_brick_03: { size: 3.281 },
  herringbone_pavement: { size: 6.562 },
  concrete_floor_worn_001: { size: 9.843 },
  plywood: { size: 1.64 },
  japanese_cedar_planks: { size: 3.707 },
  white_stucco: { size: 6.555 },
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
  /**
   * Reflects the surroundings captured at the unit (buildings, trees, paving) instead of the open
   * sky: glazing and glossy exterior finishes.
   */
  site?: boolean
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
  /**
   * Clear glazing drawn over the scene behind it rather than through a filtered copy of it:
   * sharp at any distance, reflecting and dimming by Fresnel's law like a real pane.
   */
  thinGlass?: boolean
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

/**
 * Scans decode off the main thread where createImageBitmap takes its options (Safari 17+, Firefox
 * 98+, the gate three's GLTFLoader uses). An <img> would instead be decoded synchronously by the
 * first GPU upload, stalling a frame for every arriving map.
 */
const decodeOffThread = (() => {
  if (typeof createImageBitmap === 'undefined' || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const safari = /^((?!chrome|android).)*safari/i.test(ua)
  const safariVersion = Number(ua.match(/Version\/(\d+)/)?.[1] ?? -1)
  const firefoxVersion = Number(ua.match(/Firefox\/(\d+)\./)?.[1] ?? -1)
  return !(safari && safariVersion < 17) && !(ua.includes('Firefox') && firefoxVersion < 98)
})()

/**
 * Decoded already upright, so the texture keeps flipY false (as three's in-shader flip for bitmaps
 * requires), and without premultiplication or color conversion: the same texels an <img> uploads.
 */
const decode = (blob: Blob) =>
  createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })

/** Textures whose decoded pixels are released after upload; their encoded scan is kept. */
const releasable = new Set<Texture>()

async function fetchBitmapTexture(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} for ${url}`)
  const blob = await response.blob()
  const texture = new Texture(await decode(blob))
  texture.flipY = false
  texture.userData.scan = blob
  // Once uploaded, the pixels live on the GPU: free the decoded copy (up to 16 MB per map).
  texture.onUpdate = () => (texture.image as ImageBitmap).close()
  return texture
}

/**
 * Decodes released maps again. A new renderer uploads every texture afresh, so the canvas's gl
 * factory awaits this before the renderer draws anything.
 */
export function restoreTextures() {
  return Promise.all(
    [...releasable]
      .filter((texture) => (texture.image as ImageBitmap).width === 0)
      .map(async (texture) => {
        texture.image = await decode(texture.userData.scan as Blob)
        texture.needsUpdate = true
      }),
  )
}

/** Retries a dropped request twice (after 1 s, then 2 s) before giving up on a map. */
function fetchTexture(url: string, attempt = 0): Promise<Texture> {
  const request = decodeOffThread ? fetchBitmapTexture(url) : loader.loadAsync(url)
  return request.catch((error: unknown) => {
    if (attempt >= 2) throw error
    return new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** attempt)).then(() =>
      fetchTexture(url, attempt + 1),
    )
  })
}

/** A failed set is requested again after this pause, doubling each round up to five minutes. */
const RETRY_SET_AFTER_MS = 30_000
const RETRY_SET_MAX_MS = 300_000
const failedRounds = new Map<TextureSet, number>()
/** Surfaces built while their set was failing, given its scans when a later round lands. */
const waiting = new Map<TextureSet, ((maps: Maps) => void)[]>()

/**
 * A set's scans, waiting through failed rounds: a dropped connection that recovers still textures
 * every surface that asked during the outage.
 */
function whenLoaded(set: TextureSet): Promise<Maps> {
  return load(set).catch(
    () =>
      new Promise<Maps>((resolve) => {
        let list = waiting.get(set)
        if (!list) waiting.set(set, (list = []))
        list.push(resolve)
      }),
  )
}

function load(set: TextureSet): Promise<Maps> {
  let pending = sets.get(set)
  if (pending) return pending
  const info = TEXTURE_SETS[set] as { size: number; detailOnly?: boolean }
  const names = info.detailOnly ? ['normal', 'arm'] : ['albedo', 'normal', 'arm']
  textureProgress.update(names.length, 0)
  pending = Promise.allSettled(
    names.map((name) =>
      fetchTexture(`${base}${set}/${name}.webp`)
        // A map that never arrives still counts as settled, so the progress bar always finishes.
        .finally(() => textureProgress.update(0, 1))
        .then((texture) => [name, configure(texture, info.size, name === 'albedo')] as const),
    ),
  ).then((results) => {
    const entries = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failure) {
      // The maps that did arrive are dropped with the set: free their decoded pixels now.
      entries.forEach(([, texture]) => (texture.image as Partial<ImageBitmap>).close?.())
      // Surfaces keep their neutral look; after a pause the set tries again for those waiting.
      // Its maps counted as loaded above, so nothing waits on the progress for them.
      const rounds = (failedRounds.get(set) ?? 0) + 1
      if (rounds === 1)
        console.warn(
          `The ${set} scans could not be loaded; its surfaces stay plain.`,
          failure.reason,
        )
      failedRounds.set(set, rounds)
      setTimeout(
        () => {
          if (sets.get(set) === pending) sets.delete(set)
          if (waiting.get(set)?.length) load(set).catch(() => {})
        },
        Math.min(RETRY_SET_MAX_MS, RETRY_SET_AFTER_MS * 2 ** (rounds - 1)),
      )
      throw failure.reason
    }
    entries.forEach(([, texture]) => {
      if (texture.userData.scan) releasable.add(texture)
    })
    const maps = Object.fromEntries(entries) as Maps
    ready.set(set, maps)
    failedRounds.delete(set)
    waiting.get(set)?.forEach((resolve) => resolve(maps))
    waiting.delete(set)
    return maps
  })
  sets.set(set, pending)
  return pending
}

// --- Material library ----------------------------------------------------------

const materials = new Map<string, MeshStandardNodeMaterial>()
/**
 * One environment node per radiance probe, shared by every material it lights. Node materials
 * resolve `envMap` into a fixed texture when their shader is built, so swapping probe captures
 * through `envMap` would be ignored; updating the node's value rebinds every material without
 * recompiling.
 */
type Probe = {
  node: ReturnType<typeof pmremTexture> | null
  materials: Set<MeshStandardNodeMaterial>
}
export type ProbeKind = 'interior' | 'site'
const probes: Record<ProbeKind, Probe> = {
  interior: { node: null, materials: new Set() },
  site: { node: null, materials: new Set() },
}
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

/**
 * Neutral 1x1 stand-ins bound until a set's scans arrive: white albedo, a flat normal (half float,
 * so it decodes to exactly 0,0,1), and full AO, roughness, and metalness factors. They look exactly
 * like no maps at all, but the material's shader already has its final shape, so arriving scans
 * are swapped in without recompiling every textured material a second time. Sampler state matches
 * the scans because WebGPU pipelines are keyed on it.
 */
function neutral(
  texel: number[],
  type: typeof UnsignedByteType | typeof HalfFloatType,
  space: ColorSpace,
) {
  const data =
    type === HalfFloatType
      ? new Uint16Array(texel.map((v) => DataUtils.toHalfFloat(v)))
      : new Uint8Array(texel.map((v) => v * 255))
  const t = new DataTexture(data, 1, 1, RGBAFormat, type)
  t.colorSpace = space
  t.wrapS = t.wrapT = RepeatWrapping
  t.magFilter = LinearFilter
  t.minFilter = LinearMipmapLinearFilter
  t.needsUpdate = true
  return t
}
let stand: { albedo: Texture; normal: Texture; arm: Texture } | null = null
function standIns() {
  stand ??= {
    albedo: neutral([1, 1, 1, 1], UnsignedByteType, SRGBColorSpace),
    normal: neutral([0.5, 0.5, 1, 1], HalfFloatType, NoColorSpace),
    arm: neutral([1, 1, 1, 1], UnsignedByteType, NoColorSpace),
  }
  return stand
}

function applyMaps(material: MeshStandardNodeMaterial, spec: MaterialSpec, maps: Maps) {
  const info = TEXTURE_SETS[spec.set!] as { metallic?: boolean }
  if (maps.albedo) material.map = maps.albedo
  material.normalMap = maps.normal
  material.roughnessMap = maps.arm
  material.aoMap = maps.arm
  if (info.metallic) material.metalnessMap = maps.arm
}

export function material(spec: MaterialSpec): MeshStandardNodeMaterial {
  const key = JSON.stringify(spec)
  const existing = materials.get(key)
  if (existing) return existing
  const physical =
    spec.clearcoat !== undefined ||
    spec.sheen !== undefined ||
    spec.transmission !== undefined ||
    spec.specularIntensity !== undefined
  const m = physical ? new MeshPhysicalNodeMaterial() : new MeshStandardNodeMaterial()
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
  if (m instanceof MeshPhysicalNodeMaterial) {
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
  if (spec.thinGlass) {
    // The lit color is the pane's reflection alone (its albedo is black). Blending adds it to what
    // lies behind, dimmed by the share the pane reflects: Schlick's Fresnel for a 1.5 surface,
    // combined for the pane's two faces.
    const grazing = normalView.dot(positionViewDirection).abs().oneMinus().pow(5)
    const surface = float(0.04).add(grazing.mul(0.96))
    m.opacityNode = surface.mul(2).div(surface.add(1))
    m.transparent = true
    m.depthWrite = false
    m.blending = CustomBlending
    m.blendSrc = m.blendSrcAlpha = OneFactor
    m.blendDst = m.blendDstAlpha = OneMinusSrcAlphaFactor
    // What lies behind is already fogged; fogging the reflection's sum would veil the pane.
    m.fog = false
    m.userData.glass = true
    // The path tracers get real thin glass instead: a clear pane (preparePathTraceScene turns
    // transmission into thin-walled glass; the cloud renderer reads the swapped material). Without
    // this they would trace the black, opaque albedo and show every window as a dark mirror.
    m.userData.pathTrace = {
      color: new Color('#ffffff'),
      transmission: 1,
      thickness: 0,
      attenuationDistance: Infinity,
      roughness: 0,
      transparent: false,
    }
  }
  if (spec.set) {
    const maps = ready.get(spec.set)
    if (maps) applyMaps(m, spec, maps)
    else {
      const info = TEXTURE_SETS[spec.set] as { detailOnly?: boolean }
      const neutralMaps = standIns()
      applyMaps(m, spec, {
        ...neutralMaps,
        albedo: info.detailOnly ? undefined : neutralMaps.albedo,
      })
      // Neutral maps until the scans arrive, however many rounds that takes.
      void whenLoaded(spec.set).then((loaded) => {
        applyMaps(m, spec, loaded)
        changed('textures')
      })
    }
  }
  const kind: ProbeKind | null = spec.interior ? 'interior' : spec.site ? 'site' : null
  if (kind) {
    probes[kind].materials.add(m)
    if (probes[kind].node) m.envNode = probes[kind].node
  }
  materials.set(key, m)
  return m
}

/** Point every material a probe lights at its latest capture. */
export function setProbeEnvironment(kind: ProbeKind, texture: Texture | null) {
  const probe = probes[kind]
  if (texture && probe.node) {
    probe.node.value = texture
  } else if (texture !== null || probe.node !== null) {
    // Adding or removing the probe changes the shader: rebuild once.
    probe.node = texture ? pmremTexture(texture) : null
    probe.materials.forEach((m) => {
      m.envNode = probe.node
      m.needsUpdate = true
    })
  }
  changed('probe')
}

/** Point every interior material at the latest captured interior radiance probe. */
export function setInteriorEnvironment(texture: Texture | null) {
  setProbeEnvironment('interior', texture)
}

/** Loaded maps of a set, for custom node materials (shared with the library's materials). */
export function textureMaps(set: TextureSet) {
  return whenLoaded(set)
}

/** Starts (or joins) a set's download without waiting on it. */
export function prefetchTextures(set: TextureSet) {
  load(set).catch(() => {})
}
