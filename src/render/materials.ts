import {
  Color,
  DataTexture,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  Vector2,
  type ColorRepresentation,
  type Side,
  type Material,
  type Object3D,
} from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { pmremTexture } from 'three/tsl'
import { textureProgress, type AssetMapState } from './progress'
import textureManifest from 'virtual:fury-textures'

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
  anisotropy = Number.isFinite(value) ? Math.max(1, Math.min(16, value)) : 1
  resources.forEach((resource) =>
    Object.values(resource.maps).forEach((map) => {
      map.anisotropy = anisotropy
      map.needsUpdate = true
    }),
  )
}

// --- Load tracking ------------------------------------------------------------

export { textureProgress }

type Role = AssetMapState['role']
type Source = { image: ImageBitmap; bytes: number; refs: number }
type Channel = {
  state: AssetMapState
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  source?: Source
  started?: boolean
}
type Consumer = (maps: Maps, states: readonly AssetMapState[]) => void
type Resource = {
  set: TextureSet
  generation: number
  maps: Maps
  channels: Partial<Record<Role, Channel>>
  consumers: Set<Consumer>
  active: boolean
}

const MAX_ATTEMPTS = 3
const LOAD_CONCURRENCY = 3
const DOWNLOAD_TIMEOUT_MS = 45000
const DECODE_TIMEOUT_MS = 30000
const SOURCE_LIMIT_BYTES = 64 * 1024 * 1024
const SOURCE_LIMIT_COUNT = 24
const sources = new Map<string, Source>()
// There are only 60 versioned maps in this catalog. Failures hold no promises or images.
const attempts = new Map<string, number>()
const failures = new Map<string, string>()
const resources = new Map<TextureSet, Resource>()
let generation = 0
let nextOwner = 0

function roles(set: TextureSet): Role[] {
  return 'detailOnly' in TEXTURE_SETS[set] ? ['normal', 'arm'] : ['albedo', 'normal', 'arm']
}
function mapInfo(set: TextureSet, role: Role) {
  return textureManifest.maps[`${set}/${role}`]
}
function pruneSources() {
  let bytes = [...sources.values()].reduce((sum, source) => sum + source.bytes, 0)
  for (const [key, source] of sources) {
    if (sources.size <= SOURCE_LIMIT_COUNT && bytes <= SOURCE_LIMIT_BYTES) break
    if (source.refs) continue
    sources.delete(key)
    bytes -= source.bytes
    source.image.close()
  }
}

/** Deterministic, restrained material-family fallback; it is not a recovered scan. */
function fallback(set: TextureSet, role: Role) {
  const size = 32
  const pixels = new Uint8Array(size * size * 4)
  const timber = /oak|teak|hinoki|laminate|bark/.test(set)
  const dark = /rubber|leafy/.test(set)
  const metallic = 'metallic' in TEXTURE_SETS[set]
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      const grain = timber ? Math.sin((y * Math.PI) / 4) * 8 : ((x * 17 + y * 13) % 7) - 3
      const rgb =
        role === 'normal'
          ? [128, 128, 255]
          : role === 'arm'
            ? [255, metallic ? 95 : 220, metallic ? 255 : 0]
            : timber
              ? [162 + grain, 129 + grain, 91 + grain]
              : dark
                ? [76 + grain, 80 + grain, 68 + grain]
                : [220 + grain, 218 + grain, 213 + grain]
      pixels.set([...rgb, 255], offset)
    }
  const texture = new DataTexture(pixels, size, size)
  texture.name = `fallback:${set}/${role}`
  texture.generateMipmaps = true
  return configure(texture, TEXTURE_SETS[set].size, role === 'albedo')
}

function configure(texture: Texture, size: number, color: boolean) {
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.repeat.set(1 / size, 1 / size)
  texture.colorSpace = color ? SRGBColorSpace : NoColorSpace
  texture.anisotropy = anisotropy
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}

function states(resource: Resource) {
  return Object.values(resource.channels).map((channel) => channel.state)
}
function notify(resource: Resource) {
  if (!resource.active || resource.generation !== generation) return
  resource.consumers.forEach((consumer) => consumer(resource.maps, states(resource)))
  changed('textures')
}
function bindSource(resource: Resource, role: Role, source: Source) {
  const channel = resource.channels[role]!
  const previous = resource.maps[role]
  source.refs++
  channel.source = source
  const map = configure(
    new Texture(source.image),
    TEXTURE_SETS[resource.set].size,
    role === 'albedo',
  )
  map.name = mapInfo(resource.set, role).sha256
  resource.maps = { ...resource.maps, [role]: map }
  channel.state = {
    ...channel.state,
    status: 'ready',
    source: 'ready',
    render: 'ready',
    error: undefined,
  }
  notify(resource)
  previous?.dispose()
}
type LoadJob = {
  run: () => Promise<void>
  cancel: () => void
  stalled: boolean
}
const loadQueue: LoadJob[] = []
const activeLoads = new Set<LoadJob>()

function admitLoads() {
  // Native image decode cannot be aborted. Never recycle its permit before it settles.
  if (activeLoads.size === LOAD_CONCURRENCY && [...activeLoads].every((job) => job.stalled)) {
    loadQueue.splice(0).forEach((job) => job.cancel())
    return
  }
  while (activeLoads.size < LOAD_CONCURRENCY && loadQueue.length) {
    const job = loadQueue.shift()!
    activeLoads.add(job)
    void job.run().finally(() => {
      activeLoads.delete(job)
      admitLoads()
    })
  }
}

function request(resource: Resource, role: Role, manual = false) {
  const channel = resource.channels[role]!
  const info = mapInfo(resource.set, role)
  const key = info.sha256
  if (!resource.active || channel.controller || channel.source) return
  const cached = sources.get(key)
  if (cached) {
    sources.delete(key)
    sources.set(key, cached)
    bindSource(resource, role, cached)
    return
  }
  const tried = attempts.get(key) ?? 0
  if (tried >= MAX_ATTEMPTS || (!manual && failures.has(key))) {
    channel.state = {
      ...channel.state,
      attempts: tried,
      status: 'degraded',
      source: 'failed',
      error: failures.get(key) ?? 'Retry limit reached; reload to try again.',
    }
    notify(resource)
    return
  }
  const controller = new AbortController()
  channel.controller = controller
  channel.started = false
  channel.state = {
    ...channel.state,
    status: 'pending',
    source: 'pending',
    attempts: tried,
    error: undefined,
  }
  let finished = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const live = () =>
    !finished && resource.active && resource.generation === generation && !controller.signal.aborted
  const finish = () => {
    finished = true
    if (channel.controller === controller) {
      channel.controller = undefined
      channel.started = false
    }
  }
  const fail = (error: unknown, retryable = true) => {
    if (finished) return
    finish()
    if (!resource.active || resource.generation !== generation) return
    const reason = error instanceof Error ? error.message : 'Image download or decode failed.'
    failures.set(key, reason)
    const automatic = retryable && tried === 0
    channel.state = {
      ...channel.state,
      status: automatic ? 'pending' : 'degraded',
      source: automatic ? 'pending' : 'failed',
      error: reason,
    }
    if (automatic)
      channel.timer = setTimeout(() => {
        channel.timer = undefined
        request(resource, role, true)
      }, 300)
    notify(resource)
  }
  const deadline = (stage: string, ms: number) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      job.stalled = true
      fail(new Error(`${stage} timed out after ${ms / 1000} seconds.`))
      controller.abort()
      admitLoads()
    }, ms)
  }
  const abort = () => {
    const queued = loadQueue.indexOf(job)
    if (queued !== -1) loadQueue.splice(queued, 1)
    finish()
    if (!activeLoads.has(job)) controller.signal.removeEventListener('abort', abort)
  }
  const job: LoadJob = {
    stalled: false,
    cancel() {
      fail(
        new Error('Texture loader is waiting for a stalled operation to finish; retry later.'),
        false,
      )
      controller.abort()
    },
    async run() {
      try {
        if (!live()) return
        channel.started = true
        attempts.set(key, tried + 1)
        channel.state = { ...channel.state, attempts: tried + 1 }
        notify(resource)
        if (!live()) return
        deadline('Download', DOWNLOAD_TIMEOUT_MS)
        const response = await fetch(info.url, { signal: controller.signal })
        if (!live()) return
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blob = await response.blob()
        if (!live()) return
        deadline('Decode', DECODE_TIMEOUT_MS)
        const image = await createImageBitmap(blob, {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
          imageOrientation: 'flipY',
        })
        if (!live()) {
          image.close()
          return
        }
        const existing = sources.get(key)
        const source = existing ?? { image, refs: 0, bytes: image.width * image.height * 4 }
        if (existing) image.close()
        else sources.set(key, source)
        failures.delete(key)
        attempts.delete(key)
        bindSource(resource, role, source)
        pruneSources()
      } catch (error) {
        fail(error)
      } finally {
        clearTimeout(timeout)
        controller.signal.removeEventListener('abort', abort)
        finish()
      }
    },
  }
  controller.signal.addEventListener('abort', abort, { once: true })
  loadQueue.push(job)
  notify(resource)
  admitLoads()
}
function createResource(set: TextureSet): Resource {
  const maps = Object.fromEntries(roles(set).map((role) => [role, fallback(set, role)])) as Maps
  const resource: Resource = {
    set,
    generation,
    maps,
    consumers: new Set(),
    channels: {},
    active: true,
  }
  for (const role of roles(set))
    resource.channels[role] = {
      state: {
        id: `${set}/${role}:${mapInfo(set, role).sha256}`,
        set,
        role,
        status: 'pending',
        source: 'pending',
        render: 'fallback',
        attempts: attempts.get(mapInfo(set, role).sha256) ?? 0,
        maxAttempts: MAX_ATTEMPTS,
      },
    }
  resources.set(set, resource)
  return resource
}
function disposeResource(resource: Resource) {
  if (!resource.active) return
  resource.active = false
  Object.values(resource.channels).forEach((channel) => {
    if (
      channel.controller &&
      channel.started &&
      !channel.source &&
      channel.state.source === 'pending'
    ) {
      const key = mapInfo(resource.set, channel.state.role).sha256
      attempts.set(key, Math.max(0, (attempts.get(key) ?? 1) - 1))
    }
    channel.controller?.abort()
    clearTimeout(channel.timer)
    if (channel.source) channel.source.refs--
  })
  Object.values(resource.maps).forEach((map) => map.dispose())
  if (resources.get(resource.set) === resource) resources.delete(resource.set)
  pruneSources()
}

/** Live lease for custom node materials. Unsubscribe before disposing the consumer. */
export function subscribeTextureMaps(
  set: TextureSet,
  consumer: Consumer,
  ownerId = `maps:${++nextOwner}`,
) {
  let resource: Resource
  let progress: ReturnType<typeof textureProgress.register>
  let active = true
  const listener: Consumer = (maps, state) => {
    if (active) {
      try {
        consumer(maps, state)
      } catch (error) {
        console.error('Texture consumer failed to bind maps.', error)
      }
      progress.update(state)
    }
  }
  const attach = () => {
    resource = resources.get(set) ?? createResource(set)
    progress = textureProgress.register(ownerId, generation, () => {
      roles(set).forEach((role) => {
        const channel = resource.channels[role]!
        if (channel.state.source === 'failed') {
          clearTimeout(channel.timer)
          channel.timer = undefined
          request(resource, role, true)
        }
      })
    })
    resource.consumers.add(listener)
    listener(resource.maps, states(resource))
    roles(set).forEach((role) => request(resource, role))
  }
  const detach = () => {
    resource.consumers.delete(listener)
    progress.dispose()
    if (resource.consumers.size === 0) disposeResource(resource)
  }
  const rebind = () => {
    detach()
    attach()
  }
  generationListeners.add(rebind)
  attach()
  return () => {
    if (!active) return
    active = false
    generationListeners.delete(rebind)
    detach()
  }
}

const generationListeners = new Set<() => void>()
/** Call on renderer/device recreation. CPU sources survive; all texture wrappers are new. */
export function setMaterialGeneration(value: number) {
  if (generation === value) return
  generation = value
  // Invalidate every old resource before any new subscriber is attached.
  resources.forEach(disposeResource)
  textureProgress.setGeneration(value)
  generationListeners.forEach((listener) => listener())
}

/** Logical inventory, not a measurement of driver memory or successful GPU upload. */
export function materialInventory() {
  return {
    generation,
    activeSets: resources.size,
    activeLoads: activeLoads.size,
    queuedLoads: loadQueue.length,
    stalledLoads: [...activeLoads].filter((job) => job.stalled).length,
    loadConcurrency: LOAD_CONCURRENCY,
    owners: textureProgress.snapshot().owners,
    activeEncodedBytes: [...resources.values()].reduce(
      (sum, r) => sum + roles(r.set).reduce((n, role) => n + mapInfo(r.set, role).encodedBytes, 0),
      0,
    ),
    cpuSources: sources.size,
    cpuDecodedBytes: [...sources.values()].reduce((sum, source) => sum + source.bytes, 0),
    textureWrappers: [...resources.values()].reduce((sum, r) => sum + roles(r.set).length, 0),
    estimatedTextureBytesWithMips: [...resources.values()].reduce(
      (sum, r) =>
        sum +
        roles(r.set).reduce(
          (n, role) => n + ((r.channels[role]?.source?.bytes ?? 32 * 32 * 4) * 4) / 3,
          0,
        ),
      0,
    ),
    renderTargetBytes: null,
  }
}

// --- Material library ----------------------------------------------------------

const materials = new Map<string, MeshStandardNodeMaterial>()
type Binding = { spec: MaterialSpec; refs: number; releases: Set<() => void>; disposed: boolean }
const bindings = new WeakMap<Material, Binding>()
const interiorMaterials = new Set<MeshStandardNodeMaterial>()
/**
 * One environment node shared by every interior material. Node materials resolve `envMap` into a
 * fixed texture when their shader is built, so swapping probe captures through `envMap` would be
 * ignored; updating this node's value rebinds every interior material without recompiling.
 */
let interiorEnvironment: ReturnType<typeof pmremTexture> | null = null
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
  changeListeners.forEach((listener) => {
    try {
      listener(change)
    } catch (error) {
      console.error('Material change subscriber failed.', error)
    }
  })
}

function applyMaps(material: MeshStandardNodeMaterial, spec: MaterialSpec, maps: Maps) {
  const info = TEXTURE_SETS[spec.set!] as { metallic?: boolean }
  if (maps.albedo) material.map = maps.albedo
  material.normalMap = maps.normal
  material.roughnessMap = maps.arm
  material.aoMap = maps.arm
  if (info.metallic) material.metalnessMap = maps.arm
  material.needsUpdate = true
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
  if (spec.set) {
    // No network or device allocation during render; committed owners acquire maps below.
    m.userData.textureSet = spec.set
  }
  materials.set(key, m)
  const binding: Binding = { spec, refs: 0, releases: new Set(), disposed: false }
  bindings.set(m, binding)
  m.addEventListener('dispose', () => {
    binding.disposed = true
    binding.releases.forEach((release) => release())
    binding.releases.clear()
    interiorMaterials.delete(m)
    if (materials.get(key) === m) materials.delete(key)
  })
  if (materials.size > 256) {
    for (const [oldKey, old] of materials) {
      if (materials.size <= 256) break
      if (bindings.get(old)?.refs === 0 && old !== m) {
        materials.delete(oldKey)
        old.dispose()
      }
    }
  }
  return m
}

/** Retains shared library materials for a committed subtree; release before dropping its meshes. */
export function retainMaterials(list: Iterable<Material>, ownerId = `materials:${++nextOwner}`) {
  const retained: { material: MeshStandardNodeMaterial; release?: () => void }[] = []
  for (const candidate of new Set(list)) {
    const binding = bindings.get(candidate)
    if (!binding) continue
    const m = candidate as MeshStandardNodeMaterial
    // Explicit reacquisition is allowed after StrictMode's effect cleanup, never by late I/O.
    binding.disposed = false
    binding.refs++
    if (binding.spec.interior) {
      interiorMaterials.add(m)
      m.envNode = interiorEnvironment
    }
    let release: (() => void) | undefined
    if (binding.spec.set) {
      release = subscribeTextureMaps(
        binding.spec.set,
        (maps) => {
          if (!binding.disposed && binding.refs > 0) applyMaps(m, binding.spec, maps)
        },
        `${ownerId}:${m.uuid}`,
      )
      binding.releases.add(release)
    }
    retained.push({ material: m, release })
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    for (const { material: m, release } of retained) {
      const binding = bindings.get(m)!
      release?.()
      if (release) binding.releases.delete(release)
      if (--binding.refs !== 0) continue
      m.map = m.normalMap = m.roughnessMap = m.aoMap = m.metalnessMap = null
      m.envNode = null
      m.dispose()
    }
  }
}

export function retainObjectMaterials(root: Object3D, ownerId?: string) {
  const list = new Set<Material>()
  root.traverse((object) => {
    const candidate = object as Object3D & { material?: Material | Material[] }
    if (candidate.material) {
      for (const m of Array.isArray(candidate.material) ? candidate.material : [candidate.material])
        list.add(m)
    }
  })
  return retainMaterials(list, ownerId)
}

/** Point every interior material at the latest captured interior radiance probe. */
export function setInteriorEnvironment(texture: Texture | null) {
  if (texture && interiorEnvironment) {
    interiorEnvironment.value = texture
  } else if (texture !== null || interiorEnvironment !== null) {
    // Adding or removing the probe changes the shader: rebuild once.
    interiorEnvironment = texture ? pmremTexture(texture) : null
    interiorMaterials.forEach((m) => {
      m.envNode = interiorEnvironment
      m.needsUpdate = true
    })
  }
  changed('probe')
}

/** Loaded maps of a set, for custom node materials (shared with the library's materials). */
export function textureMaps(set: TextureSet): Promise<Maps> {
  // Legacy one-shot callers should migrate to subscribeTextureMaps for retry and disposal.
  // Keep the lease until explicit releaseTextureMaps; unlike live subscriptions this cannot
  // infer the lifetime of a caller holding the resolved Texture references.
  const cached = legacyMapLeases.get(set)
  if (cached?.generation === generation) return cached.promise
  let resolve!: (maps: Maps) => void
  const promise = new Promise<Maps>((done) => {
    resolve = done
  })
  const release = subscribeTextureMaps(set, (maps, states) => {
    if (states.every((state) => state.source !== 'pending')) resolve(maps)
  })
  legacyMapLeases.set(set, { promise, release, generation })
  cached?.release()
  return promise
}
const legacyMapLeases = new Map<
  TextureSet,
  { promise: Promise<Maps>; release: () => void; generation: number }
>()
export function releaseTextureMaps(set: TextureSet) {
  legacyMapLeases.get(set)?.release()
  legacyMapLeases.delete(set)
}
