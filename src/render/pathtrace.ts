import {
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  MeshStandardMaterial,
  RGBAFormat,
  RectAreaLight,
  RenderTarget,
  StorageTexture,
  Vector2,
  Vector3,
  Vector4,
  type BufferGeometry,
  type Camera,
  type InstancedMesh,
  type Material,
  type PerspectiveCamera,
  type Mesh,
  type Object3D,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import type { WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu'
import {
  SUN_ANGULAR_RADIUS,
  SUN_INTENSITY,
  environmentRadiance,
  equirectRadiance,
  studioRadiance,
  type SkyLook,
} from '../lib/visuals'
import { AdaptiveSampler, MIN_SETTLE_SAMPLES } from './adaptive'
import { bench } from './bench'
import { GBuffer, MultiViewHistory, ViewHistory, type HistoryKeys } from './history'
import { nextTracePasses } from './traceBudget'
import { stillInstances } from './instances'
import type { TraceState } from './traceStatus'

/**
 * Progressive path tracing of the live scene, used whenever the camera rests and for exports.
 *
 * The tracer captures geometry, materials, and lights once per scene revision, so anything the
 * path tracer should see differently from the rasterizer is swapped in only for that capture:
 *
 * - `object.userData.pathTrace = false` hides an object (the raster sky dome, helpers).
 * - `material.userData.pathTrace = { ... }` overrides material properties, so node materials whose
 *   look lives in TSL (foliage atlases, the scanned ground, the planar mirror) expose plain
 *   physically based values the tracer can read.
 * - Meshes with unlit materials (lines, labels, the sky) are hidden automatically.
 * - Volumetric glass becomes thin-walled glass tinted by its absorption, since panes are modeled
 *   as open sheets rather than closed solids.
 * - The sun becomes a distant disc of its true angular size, so shadows soften with distance and
 *   glossy surfaces show a real sun glint, while the sky arrives as an HDR radiance map with the
 *   same clouds as the raster sky.
 */

/** `?traceStats=1` logs, per view, when the first traced image appeared and when it settled. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

/**
 * Samples per pixel at which a resting view stops refining: denoised, 256 is clean on every
 * surface the gym shows, and a resting view is looked at, not kept. The same count as the spin's
 * good tier, so the two engines give one image for one view.
 */
export const REST_SAMPLES = 256
/**
 * Samples per pixel an exported still waits for (or until EXPORT_TIMEOUT_MS): a view that is
 * resting at REST_SAMPLES carries on to this when a capture asks (`retarget`), so an export keeps
 * its quality.
 */
export const EXPORT_SAMPLES = 384
export const EXPORT_TIMEOUT_MS = 45000

type TracerModule = typeof import('three-gpu-pathtracer/webgpu')
type Modules = { tracer: TracerModule; initUNetFromURL: unknown }
let modules: Promise<Modules> | null = null
/** The tracer and denoiser load on demand so they never weigh on the first paint. */
export function loadTracerModule() {
  modules ??= Promise.all([
    import('three-gpu-pathtracer/webgpu'),
    import('oidn-web').catch(() => null),
  ]).then(([tracer, oidn]) => ({ tracer, initUNetFromURL: oidn?.initUNetFromURL ?? null }))
  return modules
}
/** Open Image Denoise weights (RT filter, HDR color guided by albedo and normals). */
export const DENOISER_WEIGHTS = `${import.meta.env.BASE_URL}denoise/rt_hdr_alb_nrm.tza`

/** Distance of the stand-in sun disc; far enough that it subtends the same angle everywhere. */
const SUN_DISTANCE = 12000
const ENV_WIDTH = 1024
const ENV_HEIGHT = 512
/**
 * Most passes per batch. Once most pixels have converged a pass is cheap, so batches grow until
 * they keep the GPU busy for about two display frames.
 */
const MAX_PASSES = 64
/** Wavefront path slots per dispatch: ~300 bytes each, so this stays under 128 MB bindings. */
const FRAME_BUDGET = 262144

type Restore = () => void
const placeholder = new MeshStandardMaterial()

function isLit(material: Material) {
  const m = material as Material & {
    isMeshStandardMaterial?: boolean
    isMeshStandardNodeMaterial?: boolean
  }
  return Boolean(m.isMeshStandardMaterial || m.isMeshStandardNodeMaterial)
}

/**
 * Temporarily assigns properties, returning a function that puts the old values back. A
 * material's version is put back too: its physical properties count a change of shader when they
 * cross zero (a pane's transmission turned on for the tracer, off again after), and the raster
 * renderer never sees the swap, so nothing changed for it; the scene fingerprints read the
 * version, and would otherwise find a new design after every capture.
 */
function assign(target: object, values: Record<string, unknown>, restores: Restore[]) {
  const record = target as Record<string, unknown>
  const previous: Record<string, unknown> = {}
  for (const key of Object.keys(values)) previous[key] = record[key]
  const version = (target as Material).isMaterial ? (target as Material).version : null
  Object.assign(record, values)
  restores.push(() => {
    Object.assign(record, previous)
    if (version !== null) record.version = version
  })
}

/** Thin-walled equivalent of a volumetric glass: its absorption across the pane becomes a tint. */
export function thinGlass(material: Material & Record<string, unknown>) {
  const thickness = (material.thickness as number) ?? 0
  const distance = (material.attenuationDistance as number) ?? Infinity
  if (!(thickness > 0) && distance === Infinity) return null
  const color = (material.color as { clone: () => { r: number; g: number; b: number } }).clone()
  const attenuation = material.attenuationColor as { r: number; g: number; b: number } | undefined
  if (attenuation && distance < Infinity && thickness > 0) {
    const depth = thickness / distance
    color.r *= Math.pow(attenuation.r, depth)
    color.g *= Math.pow(attenuation.g, depth)
    color.b *= Math.pow(attenuation.b, depth)
  }
  return { thickness: 0, attenuationDistance: Infinity, color }
}

/** The sun as path tracers see it, or null when it is down or the setting is the studio. */
export function sunLight(look: SkyLook) {
  const { sunlight } = look
  if (sunlight.intensity <= 1e-4 || look.environment === 'studio') return null
  return {
    /** Unit vector toward the sun. */
    direction: [...sunlight.direction] as [number, number, number],
    color: [...sunlight.color] as [number, number, number],
    irradiance: SUN_INTENSITY * sunlight.intensity,
    angularRadius: SUN_ANGULAR_RADIUS,
  }
}

/**
 * Swaps the scene into its path-traced form and returns a function that restores it. Everything
 * happens synchronously around the tracer's capture, so the rasterizer never sees the swap.
 */
export function preparePathTraceScene(scene: Scene, look: SkyLook, environment: Texture) {
  const restores: Restore[] = []
  const seen = new Set<Material>()
  scene.traverse((object: Object3D) => {
    const excluded = object.userData.pathTrace === false
    if (excluded && object.visible) assign(object, { visible: false }, restores)
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const traceable = materials.every((m) => m.userData.pathTrace || isLit(m))
    if (excluded || !traceable) {
      // The tracer still indexes hidden meshes' materials, so give them a plain one.
      assign(mesh, { visible: false, material: placeholder }, restores)
      return
    }
    for (const material of materials) {
      if (seen.has(material)) continue
      seen.add(material)
      const override = material.userData.pathTrace as Record<string, unknown> | undefined
      if (override) assign(material, override, restores)
      const record = material as Material & Record<string, unknown>
      if (((record.transmission as number) ?? 0) > 0) {
        const thin = thinGlass(record)
        if (thin) assign(material, thin, restores)
      }
    }
  })

  // The sun as a disc light at its true angular size, replacing the raster directional light.
  const sunlight = sunLight(look)
  if (sunlight) {
    const radius = SUN_DISTANCE * Math.tan(sunlight.angularRadius)
    const sun = new RectAreaLight(0xffffff, 1, radius * 2, radius * 2) as RectAreaLight & {
      isCircular: boolean
    }
    sun.isCircular = true
    sun.userData.sun = true
    sun.color.setRGB(...sunlight.color)
    // A disc of radius r at distance d subtends π r²/d², so radiance = irradiance / solid angle.
    sun.intensity =
      sunlight.irradiance / ((Math.PI * radius * radius) / (SUN_DISTANCE * SUN_DISTANCE))
    sun.position.copy(new Vector3(...sunlight.direction).multiplyScalar(SUN_DISTANCE))
    sun.lookAt(0, 0, 0)
    sun.updateMatrixWorld()
    scene.add(sun)
    restores.push(() => scene.remove(sun))
  }

  assign(
    scene,
    {
      environment,
      background: environment,
      environmentIntensity: 1,
      backgroundIntensity: 1,
      backgroundBlurriness: 0,
    },
    restores,
  )
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  }
}

/**
 * Cheap fingerprints of what the tracer captures, one per kind of change, so an edit rebuilds
 * only what it touched: meshes appearing, disappearing, or changing shape need a new capture
 * (BVH and kernels), while moved objects, changed finishes, and changed lights are updated in
 * place.
 */
export type SceneParts = {
  structure: number
  transforms: number
  materials: number
  lights: number
}

/**
 * Views are cached separately, but both see the whole scene through glazing and reflections.
 * A visible edit invalidates both; only objects excluded from tracing can be ignored safely.
 */
export type ScenePart = 'exterior' | 'interior'

/** A string folded into one number, for the fingerprints. */
function fold(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

/**
 * What tells a geometry apart: the key of its content when its maker gave it one (geometry.ts,
 * parts.ts batch), so a part list rebuilt to the same shape reads the same; else its id.
 */
function geometryKey(geometry: BufferGeometry) {
  const key = (geometry.userData as { key?: unknown }).key
  return typeof key === 'string' ? fold(key) : geometry.id
}

/**
 * The fingerprints of the whole scene, or of one `part` of it. A part leaves out subtrees with
 * `userData.pathTrace === false` (the dimensions helpers, the raster sun), which no tracer sees,
 * so toggling them changes no frame; its objects are read by what they show, not by identity,
 * and in no particular order: a model rebuilt from the same parts (React remounts it for an edit
 * elsewhere in its props) reads the same. The whole scene is the local tracer's: it keeps them
 * all, and reads objects by identity, since it keeps references to the meshes it captured and
 * updates them in place while the structure holds.
 */
export function sceneParts(scene: Scene, part?: ScenePart): SceneParts {
  const { structure, transforms, materials, lights } = fingerprints(scene, part !== undefined)
  return { structure, transforms, materials, lights }
}

/**
 * Where a material sends light of its own or lets it through: what it emits, and, for glass, the
 * material itself. Read only for the history's key (historySignature): an emitter or a pane
 * changes the light across the whole room, not just on its own surface.
 */
function transport(material: Material, mix: (value: number) => void) {
  const m = material as Material & {
    id: number
    emissive?: { r: number; g: number; b: number }
    emissiveIntensity?: number
    emissiveMap?: Texture | null
    transmission?: number
  }
  const override = material.userData.pathTrace as Record<string, unknown> | undefined
  const intensity = m.emissiveIntensity ?? 0
  if (m.emissive && intensity > 0) {
    mix(m.emissive.r * intensity)
    mix(m.emissive.g * intensity)
    mix(m.emissive.b * intensity)
    if (m.emissiveMap) mix(fold(m.emissiveMap.uuid))
  }
  const transmission = override?.transmission ?? m.transmission ?? 0
  if (typeof transmission === 'number' && transmission > 0) {
    mix(m.id)
    mix(material.version)
  }
}

/**
 * sceneParts' fingerprints, of the whole scene by identity or of what a part shows by content, and
 * with `withTransport` the transport of every material met as well (`transport`).
 */
function fingerprints(scene: Scene, byContent: boolean, withTransport = false) {
  const identity = !byContent
  const sum = { structure: 0, transforms: 0, materials: 0, lights: 0, transport: 0 }
  const read = (object: Object3D) => {
    const hash = {
      structure: 2166136261,
      transforms: 2166136261,
      materials: 2166136261,
      lights: 2166136261,
      transport: 2166136261,
    }
    const touched = new Set<keyof typeof hash>()
    const mix = (part: keyof typeof hash, value: number) => {
      hash[part] = Math.imul(hash[part] ^ Math.round(value * 1000), 16777619)
      touched.add(part)
    }
    if (identity) mix('structure', object.id)
    mix('structure', object.visible ? 1 : 0)
    // Every element separately: a weighted sum cancels for some moves, such as a floor-plan
    // drag of (4.25, -2.75) ft.
    for (const element of object.matrixWorld.elements) mix('transforms', element)
    const mesh = object as Mesh & {
      instanceMatrix?: { version: number }
      isInstancedMesh?: boolean
    }
    if (mesh.isMesh) {
      mix('structure', identity ? mesh.geometry.id : geometryKey(mesh.geometry))
      mix('structure', mesh.instanceMatrix?.version ?? 0)
      // Every instance, as the stills capture them, however many the raster tier draws.
      mix('structure', mesh.isInstancedMesh ? stillInstances(mesh as unknown as InstancedMesh) : 0)
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        const m = material as Material & { id: number; emissiveIntensity?: number }
        mix('materials', m.id)
        mix('materials', material.version)
        mix('materials', m.emissiveIntensity ?? 0)
        if (withTransport) transport(material, (value) => mix('transport', value))
      }
    }
    const light = object as Object3D & {
      isLight?: boolean
      intensity?: number
      color?: { r: number; g: number; b: number }
    }
    if (light.isLight) {
      mix('lights', light.intensity ?? 0)
      mix('lights', (light.color?.r ?? 0) + (light.color?.g ?? 0) * 3 + (light.color?.b ?? 0) * 7)
    }
    // Each object's own hashes are summed, so the order they are met in does not count.
    for (const part of touched) sum[part] = (sum[part] + (hash[part] >>> 0)) >>> 0
  }
  const walk = (object: Object3D) => {
    if (byContent && object.userData.pathTrace === false) return
    read(object)
    for (const child of object.children) walk(child)
  }
  walk(scene)
  return sum
}

/**
 * What decides where light goes in a scene, read by content as a part is (sceneParts with a part):
 * the shapes and whether they show, where everything is, the lights, the sky, and the emitters
 * and glass. A finish or a floor is left out, so a view traced before one changed can still seed
 * the next, a little (history.ts HistoryKeys). Never the stills' keys: those are partsSignature's.
 */
export function historySignature(scene: Scene, lookKey: string) {
  const { structure, transforms, lights, transport } = fingerprints(scene, true, true)
  let hash = 2166136261
  const mix = (value: number) => {
    hash = Math.imul(hash ^ value, 16777619)
  }
  for (let i = 0; i < lookKey.length; i++) mix(lookKey.charCodeAt(i))
  for (const value of [structure, transforms, lights, transport]) mix(value)
  return hash >>> 0
}

/**
 * One fingerprint of everything the tracer captures, including the sky and sun; of one part of
 * the scene when `part` is given (stable across equivalent remounts, excluding live helpers).
 */
export function sceneSignature(scene: Scene, lookKey: string, part?: ScenePart) {
  return partsSignature(sceneParts(scene, part), lookKey)
}

/** The fingerprints of a scene (or of a part of it) and the look, as one hash. */
export function partsSignature(parts: SceneParts, lookKey: string) {
  let hash = 2166136261
  const mix = (value: number) => {
    hash = Math.imul(hash ^ value, 16777619)
  }
  for (let i = 0; i < lookKey.length; i++) mix(lookKey.charCodeAt(i))
  for (const value of Object.values(parts)) mix(value)
  return hash >>> 0
}

const environmentCache = new Map<string, DataTexture>()
/**
 * The site's radiance as an equirect HDR map, built on the CPU from the analytic sky: here, at
 * once, unless `prepareEnvironment` built it off the main thread beforehand.
 */
export function environmentTexture(look: SkyLook) {
  const key = lookKey(look)
  const cached = environmentCache.get(key)
  if (cached) return cached
  return cacheEnvironment(
    key,
    equirectRadiance(
      ENV_WIDTH,
      ENV_HEIGHT,
      look.environment === 'studio' ? studioRadiance : (d) => environmentRadiance(d, look),
    ),
  )
}

let skyWorker: Worker | null = null
const skyRequests = new Map<string, Promise<void>>()
let skyRequest = 0

/**
 * Builds `look`'s sky map in a worker (sky.worker.ts), the same map `environmentTexture` would
 * build on the main thread (about half a second of it), so the tracer's first start finds it ready.
 * Never rejects: where the worker fails, `environmentTexture` builds it as before.
 */
export function prepareEnvironment(look: SkyLook): Promise<void> {
  const key = lookKey(look)
  if (environmentCache.has(key)) return Promise.resolve()
  const pending = skyRequests.get(key)
  if (pending) return pending
  const request = new Promise<void>((resolve) => {
    try {
      skyWorker ??= new Worker(new URL('./sky.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      return resolve()
    }
    const worker = skyWorker
    const id = ++skyRequest
    const done = () => {
      worker.removeEventListener('message', receive)
      worker.removeEventListener('error', done)
      skyRequests.delete(key)
      resolve()
    }
    const receive = (event: MessageEvent<{ id: number; data: Float32Array }>) => {
      if (event.data.id !== id) return
      if (!environmentCache.has(key)) cacheEnvironment(key, event.data.data)
      done()
    }
    worker.addEventListener('message', receive)
    worker.addEventListener('error', done)
    worker.postMessage({ id, look, width: ENV_WIDTH, height: ENV_HEIGHT })
  })
  skyRequests.set(key, request)
  return request
}

function cacheEnvironment(key: string, data: Float32Array) {
  const texture = new DataTexture(data, ENV_WIDTH, ENV_HEIGHT, RGBAFormat, FloatType)
  texture.mapping = EquirectangularReflectionMapping
  texture.minFilter = texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  // Keep only a handful: each map is 8 MB.
  if (environmentCache.size >= 4) {
    const [oldest] = environmentCache.keys()
    environmentCache.get(oldest)?.dispose()
    environmentCache.delete(oldest)
  }
  environmentCache.set(key, texture)
  return texture
}

/** Frees the cached sky maps but `look`'s (8 MB each). */
export function trimEnvironments(look: SkyLook) {
  const keep = lookKey(look)
  for (const [key, texture] of environmentCache)
    if (key !== keep) {
      texture.dispose()
      environmentCache.delete(key)
    }
}

export function lookKey(look: SkyLook) {
  return `${look.environment}|${look.sunlight.direction.map((v) => v.toFixed(4)).join(',')}|${look.night.toFixed(3)}`
}

type GPUBackend = {
  device: {
    queue: {
      writeTexture: (
        destination: { texture: unknown },
        data: ArrayBufferView,
        layout: { bytesPerRow: number; rowsPerImage: number },
        size: number[],
      ) => void
    }
  }
  get: (texture: Texture) => { texture?: unknown }
}

/** Uploads zeros to an rgba16float 3D texture so it counts as initialized. */
function zeroFill(renderer: WebGPURenderer, texture: Texture) {
  const { width, height, depth } = texture.image as { width: number; height: number; depth: number }
  renderer.initTexture(texture)
  const backend = renderer.backend as unknown as GPUBackend
  const gpuTexture = backend.get(texture).texture
  if (!gpuTexture) return
  backend.device.queue.writeTexture(
    { texture: gpuTexture },
    new Uint16Array(width * height * depth * 4),
    { bytesPerRow: width * 8, rowsPerImage: height },
    [width, height, depth],
  )
}

/**
 * Accumulation milestones at which the image is denoised and crossfaded in. They double up to
 * the resting target, so each denoised image can be compared with the last to find the regions
 * that have settled; a target raised beyond it for an export (EXPORT_SAMPLES) is denoised once
 * accumulation stops there.
 */
export const MILESTONES = [8, 16, 32, 64, 128, REST_SAMPLES]
/**
 * Milestones beyond the resting target, for views refined further (the 360° view's live profile):
 * without them nothing past REST_SAMPLES would be denoised and shown, and the adaptive sampler,
 * which compares successive images, would stop retiring settled regions. A target below one of
 * them never reaches it, so the stills and exports are unaffected.
 */
export const LONG_MILESTONES = [512, 1024]
const ALL_MILESTONES = [...MILESTONES, ...LONG_MILESTONES]
/**
 * A view seeded from the previous one is mostly converged from the start; only what that view did
 * not show is new, so its first image is denoised almost at once.
 */
const SEEDED_MILESTONES = [2, ...ALL_MILESTONES]
/**
 * An unseeded view's first images where asked (`earlyImages`, the 360° view's): denoised from 2
 * samples on, guided by the rasterized albedo and normals, a clean if softer image arrives within a
 * few frames of the view coming to rest and sharpens as the samples double.
 */
export const EARLY_MILESTONES = [2, 4, ...ALL_MILESTONES]
/** Crossfade between successive images, in milliseconds. */
const FADE_MS = 520

/**
 * Records a mark in the browser's performance timeline (User Timing), keeping only the latest of
 * each name so a long session never grows it. Never throws: timing is a diagnostic only.
 */
function mark(name: string, startTime: number, detail?: unknown) {
  try {
    performance.clearMarks(name)
    performance.mark(name, { startTime, detail })
  } catch {
    // Unrecorded.
  }
}

type Denoiser = InstanceType<TracerModule['OIDNDenoiser']>

/** oidn-web's network loader, as OIDNDenoiser calls it. */
type InitUNet = (url: string, device: unknown, options: object) => Promise<{ dispose(): void }>

/**
 * A loader handing out one network per weights and options to every caller, each with a handle
 * whose `dispose` releases only its own share: the network is disposed with the last one. A
 * network holds its weights and its working buffers on the GPU (oidn-web), so a second copy for a
 * second denoiser that never runs alongside the first is memory for nothing.
 */
export function shareUNets(init: InitUNet): InitUNet {
  const networks = new Map<string, { network: ReturnType<InitUNet>; users: number }>()
  return (url, device, options) => {
    const key = `${url}|${JSON.stringify(options)}`
    let entry = networks.get(key)
    if (!entry) {
      entry = { network: init(url, device, options), users: 0 }
      networks.set(key, entry)
      // A failed load is not kept: the next caller tries again.
      entry.network.catch(() => networks.delete(key))
    }
    const shared = entry
    shared.users++
    let released = false
    return shared.network.then(
      (network) =>
        new Proxy(network, {
          get(target, property) {
            if (property === 'dispose')
              return () => {
                if (released) return
                released = true
                if (--shared.users > 0) return
                networks.delete(key)
                target.dispose()
              }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
    )
  }
}
/**
 * What to put on screen: `from` (null for the frozen raster frame) blending into `to`. The traced
 * light is shown as it is, at the camera's exposure, as the cloud's stills are (stills.ts
 * STILL_GAIN): nothing is metered against the raster.
 */
export type TraceView = { from: Texture | null; to: Texture; t: number }

/**
 * One path tracer bound to a renderer, re-capturing the scene only when it actually changed.
 *
 * Accumulation runs continuously while the view rests. At each milestone the accumulated image is
 * copied aside and run through Open Image Denoise (guided by rasterized albedo and normals), and
 * the clean result crossfades over the previous one, so the view develops from the raster frame
 * into a converged photograph without ever showing path-tracing noise. Two denoisers alternate,
 * so the image on screen stays valid while the next one is computed. If the denoiser cannot run,
 * the raw accumulation fades in instead.
 */
export class PathTraceSession {
  readonly tracer: WebGPUPathTracer
  private readonly renderer: WebGPURenderer
  /** Absorbs the tracer's own presentation; the app composites the images itself. */
  private readonly sink = new RenderTarget(1, 1)
  private readonly denoisers: Denoiser[]
  private snapshot: StorageTexture | null = null
  /** The current view's rasterized albedo, normals, and positions (denoiser guides, reuse). */
  private readonly gbuffer = new GBuffer()
  /** The last traced view, reprojected into the next one so it never starts from nothing. */
  private readonly history: ViewHistory | MultiViewHistory
  /** Whether the current view started from the previous view's samples. */
  seeded = false
  /** Retires regions whose denoised image has settled, so samples go where it still changes. */
  private readonly adaptive = new AdaptiveSampler()
  private scene: Scene | null = null
  private camera: Camera | null = null
  private running: { index: number; samples: number } | null = null
  private shownIndex = -1
  private denoiseFailed = false
  private transition: {
    from: Texture | null
    to: Texture | null
    start: number
    fadeMs: number
  } = {
    from: null,
    to: null,
    start: 0,
    fadeMs: FADE_MS,
  }
  private signature = -1
  /** What the tracer holds: the scene parts and sky it last captured or updated. */
  private captured: { parts: SceneParts; look: string } | null = null
  /** Scans arrived since the tracer last read the materials (`texturesChanged`). */
  private materialsStale = false
  /**
   * Atlas entries the compiled kernels were built for. Their `textureInfo` uniform array is sized
   * once, when setScene compiles them; an in-place updateMaterials repacks the atlas but cannot
   * grow it, so a texture past this count would read another texture's tile.
   */
  private textureSlots = 0
  /**
   * Bumped whenever scans arrive: a view traced before had other surfaces, though no fingerprint
   * shows it (the maps are swapped in place).
   */
  private scans = 0
  /** What the current view is traced of, as `begin` found it: its history is kept under these. */
  private traced: HistoryKeys | null = null
  /** Bumped per view, so readbacks that land after the camera moved are ignored. */
  private epoch = 0
  /**
   * When this view started tracing, when its first traced image appeared, and when it settled
   * (once: an export carrying it on past the resting target does not settle it again).
   */
  private timing = { start: 0, first: 0, settled: 0, milestones: [] as [number, number][] }
  private frames = 0
  private passes = 1
  private inFlight = false
  private measuring = false
  private accumulating = false
  /** Samples per pixel reached by every pixel. */
  samples = 0
  /** Samples behind the image currently on screen. */
  shownSamples = 0
  target = REST_SAMPLES
  state: TraceState = 'off'
  private readonly fadeMs: number

  constructor(
    renderer: WebGPURenderer,
    modules: Modules,
    denoise = true,
    private readonly options: {
      multiView?: boolean
      /** Shaded vertices a path may have, the camera's hit included (Cycles' max_bounces + 1). */
      maxBounces?: number
      /**
       * Upper bounds on a directly and an indirectly lit path segment's contribution, against
       * fireflies (0 disables). Unset, the tracer's own defaults, 0 and 10.
       */
      clampDirect?: number
      clampIndirect?: number
      batchMs?: number
      maxPasses?: number
      /** Crossfade between successive images, in milliseconds. */
      fadeMs?: number
      /** The first image's crossfade from the raster frame, in milliseconds; unset, `fadeMs`. */
      firstFadeMs?: number
      /** Denoise an unseeded view's first images from 2 samples on (EARLY_MILESTONES). */
      earlyImages?: boolean
      /**
       * Larger batches once a view has traced this long undisturbed: the raster draws nothing then,
       * so the GPU time it kept free goes to samples. Any input halts the view, and the next one
       * starts at `batchMs` again.
       */
      restBatch?: { afterMs: number; batchMs: number; maxPasses: number }
      /**
       * The tracer's random numbers: its default blue-noise-dithered Sobol sequence (the same
       * sequence for every pixel, offset by a blue-noise dither), or Sobol scrambled per pixel,
       * which converged 5–9% lower in error per sample from 8 samples on in
       * scripts/convergence.mjs (equal at 2). The images shown are denoised, never raw noise.
       */
      random?: 'blue' | 'sobol'
      /**
       * Mark each view's first image and milestones in the performance timeline
       * (`fury:trace-first-image`, `fury:trace-milestone-<spp>`).
       */
      timeline?: boolean
      /**
       * Keep the views traced so far across an edit of surfaces alone (a finish, a floor, scans
       * arriving), seeding the next view with a few of their samples (history.ts HistoryKeys).
       * Off, any change at all clears them, as the stills and exports need: a still of one design
       * must never carry light of another.
       */
      keepHistoryAcrossSurfaces?: boolean
    } = {},
  ) {
    this.renderer = renderer
    this.history = options.multiView ? new MultiViewHistory() : new ViewHistory()
    const module = modules.tracer
    const tracer = new module.WebGPUPathTracer(renderer)
    tracer.frameBudget = FRAME_BUDGET
    // Six bounces: what a room lit through its glazing needs for its bounce light, and a third
    // less work per sample than ten, which added nothing a denoised image shows. The tracer
    // counts the camera's hit as a bounce and Cycles does not, so this is one indirect bounce
    // fewer than the cloud's 6 (render-server protocol.py BOUNCES). The 360° view asks for Cycles'
    // depth (viewer/liveProfile.ts); the stills and exports keep this one, unchanged.
    tracer.maxBounces = options.maxBounces ?? 6
    tracer.maxTransparentBounces = 12
    tracer.filterGlossyFactor = 0.5
    // Setting the tracer's own values again is a no-op (its setters skip an unchanged clamp).
    tracer.clampDirect = options.clampDirect ?? 0
    tracer.clampIndirect = options.clampIndirect ?? 10
    tracer.transmissiveBackground = module.TRANSMISSIVE_BACKGROUND_ENVIRONMENT
    if (options.random === 'sobol') tracer.setRandom(module.RANDOM_SOBOL)
    // The session crossfades from the raster image itself, so skip the tracer's low-res preview.
    tracer.dynamicLowRes = false
    tracer.renderDelay = 0
    tracer.minSamples = 4
    this.fadeMs = options.fadeMs ?? FADE_MS
    tracer.fadeDuration = this.fadeMs
    tracer.maxSamples = REST_SAMPLES
    // The GGX energy table is a 3D storage texture sampled without mipmaps. Keep three from
    // regenerating mipmaps after each compute write, and fill it once up front so the GPU never
    // lazily zero-fills it on first use: some Dawn backends do that through a 2D view, which is
    // invalid for a 3D texture and fails every dispatch that touches the table.
    const table = (tracer as unknown as { material: { turquinTexture: Texture } }).material
      .turquinTexture as Texture & { mipmapsAutoUpdate: boolean }
    table.generateMipmaps = false
    table.mipmapsAutoUpdate = false
    zeroFill(renderer, table)
    this.tracer = tracer
    // The two denoisers alternate (one image is on screen while the next is denoised) but never run
    // at once, so they share one network and one download of its weights.
    const initUNetFromURL = modules.initUNetFromURL
      ? shareUNets(modules.initUNetFromURL as InitUNet)
      : null
    this.denoisers =
      denoise && initUNetFromURL
        ? [0, 1].map(() => {
            const denoiser = new module.OIDNDenoiser({
              initUNetFromURL: initUNetFromURL as never,
              auxWeightsUrl: DENOISER_WEIGHTS,
            })
            denoiser.init(renderer)
            return denoiser
          })
        : []
  }

  /**
   * Starts refining the current view, re-capturing the scene only if it changed. `renderScale`, if
   * given, is the traced resolution relative to the drawing buffer from this view on (the 360°
   * view's traceScale, which follows the canvas's size).
   */
  begin(scene: Scene, camera: Camera, look: SkyLook, target = REST_SAMPLES, renderScale?: number) {
    const key = lookKey(look)
    const parts = sceneParts(scene)
    const signature = partsSignature(parts, key)
    this.state = 'preparing'
    const last = this.captured
    const stale = this.materialsStale
    const capture = () => {
      // New or reshaped meshes, or more textures than the kernels index: build the BVH and
      // kernels again.
      const restore = preparePathTraceScene(scene, look, environmentTexture(look))
      try {
        this.tracer.setScene(scene, camera)
      } finally {
        restore()
      }
      this.textureSlots = this.textureCount()
    }
    if (!last || last.parts.structure !== parts.structure) {
      capture()
    } else if (signature !== this.signature || stale) {
      // Same meshes: update in place only what changed, keeping the BVH and compiled kernels.
      // Scans that arrived changed the materials' maps, which no fingerprint reads.
      const moved = last.parts.transforms !== parts.transforms
      const sky = last.look !== key
      let grown = false
      const restore = preparePathTraceScene(scene, look, environmentTexture(look))
      try {
        if (moved) this.tracer.updateTransforms()
        if (stale || last.parts.materials !== parts.materials) {
          this.tracer.updateMaterials()
          // More textures than the kernels were compiled for (a floor swapped in while the old
          // one's scans stay in use elsewhere, or scans arriving): those need new kernels.
          grown = this.textureCount() > this.textureSlots
          // Fewer: the tracer rebuilds kernels on its own (a resize grows its pixel queue or pool)
          // and sizes the array from its length then, so it is kept at the count captured. Padding
          // is never indexed: materials name only the textures they have.
          if (!grown) this.padTextures()
        }
        if (sky) this.tracer.updateEnvironment()
        if (sky || moved || last.parts.lights !== parts.lights) this.tracer.updateLights()
      } finally {
        restore()
      }
      if (grown) capture()
      else this.tracer.updateCamera()
    } else {
      this.tracer.updateCamera()
    }
    this.materialsStale = false
    const keys = this.historyKeys(scene, key, signature)
    if (this.traced?.scene !== keys.scene) this.history.clear()
    this.traced = keys
    this.signature = signature
    this.captured = { parts, look: key }
    this.epoch++
    this.scene = scene
    this.camera = camera
    this.target = target
    this.tracer.maxSamples = target
    // Size the accumulation now rather than on the first sample, which would clear the seed. The
    // scale is set first: the tracer sizes itself from it on every sample (renderSample), with the
    // same rounding as syncSize, so a scale set afterwards would resize and reset it there.
    if (renderScale !== undefined) this.tracer.renderScale = renderScale
    const { width, height } = this.syncSize()
    this.tracer.reset()
    this.gbuffer.render(this.renderer, scene, camera as PerspectiveCamera, width, height)
    this.seeded = this.history.seed(this.renderer, this.backend, this.gbuffer, keys, target)
    this.adaptive.reset()
    for (const denoiser of this.denoisers) denoiser.reset()
    this.running = null
    this.shownIndex = -1
    this.shownSamples = 0
    this.transition = { from: null, to: null, start: 0, fadeMs: this.fadeMs }
    this.samples = 0
    this.frames = 0
    this.passes = 1
    this.accumulating = true
    this.measuring = false
    this.state = 'tracing'
    this.timing = { start: performance.now(), first: 0, settled: 0, milestones: [] }
  }

  /**
   * What a view of `scene` is kept under. Samples of a different design, time of day, or texture
   * set describe a different image. Kept across surface edits only where asked: there a view of
   * other surfaces seeds just a little.
   */
  private historyKeys(scene: Scene, key: string, signature: number): HistoryKeys {
    const surfaces = Math.imul(signature ^ this.scans, 16777619) >>> 0
    return {
      scene: this.options.keepHistoryAcrossSurfaces ? historySignature(scene, key) : surfaces,
      surfaces,
    }
  }

  /**
   * Keeps a Cycles render of `scene` as a view already traced (the library image the 360° view
   * opens on, seen from its own `camera`): the next view that starts near it is seeded from its
   * light, as from any view traced before, through the same checks (history.ts). Call while no
   * view is tracing, before the first `begin`, with the scale that `begin` will be given.
   */
  storeImage(
    scene: Scene,
    camera: PerspectiveCamera,
    look: SkyLook,
    seed: { image: Texture; table: Texture; count: number; ceiling: number },
    renderScale = this.tracer.renderScale,
  ) {
    if (this.state !== 'off') return false
    const key = lookKey(look)
    const keys = this.historyKeys(scene, key, partsSignature(sceneParts(scene), key))
    if (this.traced?.scene !== keys.scene) this.history.clear()
    this.traced = keys
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    // Sized as syncSize sizes the trace, so the stored view matches the first one begun.
    const width = Math.max(1, Math.floor(renderScale * size.x))
    const height = Math.max(1, Math.floor(renderScale * size.y))
    const gbuffer = new GBuffer()
    try {
      gbuffer.render(this.renderer, scene, camera, width, height)
      this.history.storeImage(this.renderer, seed, gbuffer, keys, width, height)
    } finally {
      // The copies are submitted: the guides may go.
      gbuffer.dispose()
    }
    return true
  }

  /** The atlas's per-texture entries, which the kernels' textureInfo array is sized from. */
  private textureInfo() {
    const tracer = this.tracer as unknown as { textureAtlas?: { textureInfo?: unknown[] } }
    return tracer.textureAtlas?.textureInfo
  }

  /** Textures packed into the tracer's atlas, as its kernels index them. */
  private textureCount() {
    return this.textureInfo()?.length ?? 0
  }

  /** Keeps the atlas's entries at the count the kernels were captured with (see `begin`). */
  private padTextures() {
    const info = this.textureInfo()
    while (info && info.length < this.textureSlots) info.push(new Vector4())
  }

  /** The tracer's accumulation targets. */
  private get backend() {
    return (
      this.tracer as unknown as {
        _pathTracer: {
          outputTarget: StorageTexture
          sampleCountTarget: StorageTexture
          setSize: (w: number, h: number) => boolean
        }
      }
    )._pathTracer
  }

  /** Allocates the accumulation at the size the tracer is about to render at. */
  private syncSize() {
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    const width = Math.max(1, Math.floor(this.tracer.renderScale * size.x))
    const height = Math.max(1, Math.floor(this.tracer.renderScale * size.y))
    this.tracer.setSize(width, height)
    this.backend.setSize(width, height)
    return { width, height }
  }

  private get denoising() {
    return this.denoisers.length > 0 && !this.denoiseFailed
  }

  /** Accumulates samples for this frame. Returns true while the image is still developing. */
  step() {
    if (this.state === 'off' || this.state === 'preparing' || this.state === 'converged')
      return false
    const now = performance.now()
    // One batch in flight at a time: the display does not pace frames that present nothing, so
    // without this the GPU queue would grow without bound.
    // Raw (undenoised) display keeps presenting through the tracer until its fade completes.
    const fading = !this.denoising && this.tracer.fadeState < 1
    if ((this.accumulating || fading) && !this.inFlight) {
      const previous = this.renderer.getRenderTarget()
      try {
        this.renderer.setRenderTarget(this.sink)
        this.tracer.renderSample()
        const backend = (this.tracer as unknown as { _pathTracer: { update: () => void } })
          ._pathTracer
        for (let i = 1; i < this.passes; i++) backend.update()
      } finally {
        this.renderer.setRenderTarget(previous)
      }
      this.frames++
      this.inFlight = true
      const epoch = this.epoch
      const device = (
        this.renderer.backend as unknown as {
          device: { queue: { onSubmittedWorkDone: () => Promise<void> } }
        }
      ).device
      device.queue
        .onSubmittedWorkDone()
        .then(() => {
          if (epoch !== this.epoch) return
          // Size batches to roughly two display frames of GPU time.
          const busy = performance.now() - now
          const budget = this.budget(now)
          if (budget)
            this.passes = nextTracePasses(this.passes, busy, budget.batchMs, budget.maxPasses)
          else if (busy < 28) this.passes = Math.min(MAX_PASSES, Math.ceil(this.passes * 1.5))
          else if (busy > 45) this.passes = Math.max(1, Math.floor(this.passes * 0.75))
        })
        .catch(() => {})
        .finally(() => {
          this.inFlight = false
        })
      // Until the first image, read the count every batch: the earliest milestones are a frame
      // or two apart.
      const early = this.options.earlyImages && this.shownIndex < 0
      if (!this.measuring && (early || this.frames % 6 === 0)) this.measure()
    }
    if (this.denoising) this.advanceDenoise(now)
    const settled = this.denoising
      ? !this.accumulating && !this.running && this.shownSamples >= this.samples
      : !this.accumulating && this.tracer.fadeState >= 1
    if (!this.timing.first && this.view(now).t > 0) {
      this.timing.first = now
      if (this.options.timeline) mark('fury:trace-first-image', now, { seeded: this.seeded })
      bench.mark('firstLocalTrace', now)
      bench.local({ firstMs: now - this.timing.start, settledMs: null })
    }
    if (settled && this.view(now).t >= 1) {
      this.state = 'converged'
      const { start, first } = this.timing
      if (this.timing.settled) return false
      this.timing.settled = now
      bench.local({ firstMs: first - start, settledMs: now - start })
      if (TRACE_STATS) {
        const { width, height } = this.tracer.target!.image as { width: number; height: number }
        const milestones = this.timing.milestones
          .map(([samples, ms]) => `${samples} spp ${(ms / 1000).toFixed(2)} s`)
          .join(', ')
        console.info(
          `[path tracing] ${width}x${height}${this.seeded ? ', seeded' : ''}: first image ${((first - start) / 1000).toFixed(2)} s, settled ${((now - start) / 1000).toFixed(1)} s${milestones ? ` (${milestones})` : ''}`,
        )
      }
    }
    return this.state !== 'converged'
  }

  /** The batch budget in force `now`: larger once the view has rested a while (`restBatch`). */
  private budget(now: number) {
    const { batchMs, maxPasses, restBatch } = this.options
    if (!batchMs) return null
    if (restBatch && now - this.timing.start >= restBatch.afterMs) return restBatch
    return { batchMs, maxPasses: maxPasses ?? MAX_PASSES }
  }

  private measure() {
    this.measuring = true
    const epoch = this.epoch
    this.tracer
      .getSampleCountsAsync()
      .then((counts) => {
        if (epoch !== this.epoch || this.state !== 'tracing') return
        this.samples = counts.min
        if (counts.min >= this.target) this.accumulating = false
      })
      .catch(() => {})
      .finally(() => {
        if (epoch === this.epoch) this.measuring = false
      })
  }

  private advanceDenoise(now: number) {
    const running = this.running
    if (running) {
      const denoiser = this.denoisers[running.index]
      if (denoiser.complete && denoiser.texture) {
        // Regions this image shows unchanged from the last one are finished: stop sampling them.
        const previous = this.shownIndex >= 0 ? this.denoisers[this.shownIndex].texture : null
        if (previous && this.shownSamples >= MIN_SETTLE_SAMPLES && this.accumulating)
          this.adaptive.update(
            this.renderer,
            denoiser.texture,
            previous,
            this.backend.sampleCountTarget,
            this.target,
          )
        const first = this.shownIndex < 0
        this.transition = {
          from: first ? null : this.view(now).to,
          to: denoiser.texture,
          start: now,
          fadeMs: first ? (this.options.firstFadeMs ?? this.fadeMs) : this.fadeMs,
        }
        this.timing.milestones.push([running.samples, now - this.timing.start])
        if (this.options.timeline)
          mark(`fury:trace-milestone-${running.samples}`, now, { seeded: this.seeded })
        this.shownIndex = running.index
        this.shownSamples = running.samples
        this.running = null
      }
      return
    }
    // Wait for the previous image to finish fading in before replacing what it fades from.
    if (this.transition.to && this.view(now).t < 1) return
    const goal = this.accumulating
      ? (this.seeded
          ? SEEDED_MILESTONES
          : this.options.earlyImages
            ? EARLY_MILESTONES
            : ALL_MILESTONES
        ).find((m) => m > this.shownSamples && m <= this.target)
      : this.samples > this.shownSamples
        ? this.samples
        : undefined
    if (goal === undefined || this.samples < goal || !this.scene || !this.camera) return
    const color = this.tracer.target!
    const { width, height } = color.image as { width: number; height: number }
    if (!this.snapshot) {
      this.snapshot = new StorageTexture(width, height)
      this.snapshot.type = FloatType
      this.snapshot.format = RGBAFormat
      this.snapshot.generateMipmaps = false
    }
    const size = this.snapshot.image as { width: number; height: number }
    if (size.width !== width || size.height !== height) this.snapshot.setSize(width, height, 1)
    this.renderer.copyTextureToTexture(color, this.snapshot)
    const index = this.shownIndex === 0 ? 1 : 0
    const denoiser = this.denoisers[index]
    denoiser.reset()
    this.running = { index, samples: this.samples }
    const epoch = this.epoch
    denoiser.denoise(this.snapshot, this.gbuffer.albedo, this.gbuffer.normal).catch((error) => {
      if (epoch !== this.epoch) return
      console.warn('Denoising is unavailable; showing the raw path-traced image.', error)
      this.denoiseFailed = true
      this.running = null
      this.transition = { from: null, to: null, start: now, fadeMs: this.fadeMs }
    })
  }

  /** The images to composite this frame. */
  view(now = performance.now()): TraceView {
    const raw = this.tracer.target!
    if (!this.denoising) return { from: null, to: raw, t: this.tracer.fadeState }
    const { from, to, start, fadeMs } = this.transition
    if (!to) return { from: null, to: raw, t: 0 }
    const t = Math.min(1, (now - start) / fadeMs)
    // Once faded in, the outgoing image may be recycled, so stop referencing it.
    return { from: t < 1 ? from : null, to, t }
  }

  /**
   * Raises the view's target without starting it over: an export asked for while the view rests
   * at REST_SAMPLES carries it on to EXPORT_SAMPLES. Every region samples on to the new target,
   * the ones retired as settled at the resting one too (no milestone lies between the two
   * targets, so nothing compares images to retire them again), and the image is denoised once
   * accumulation stops there. A view not tracing is left alone: `begin` takes the target it is
   * given.
   */
  retarget(target: number) {
    if (target <= this.target || (this.state !== 'tracing' && this.state !== 'converged')) return
    this.target = target
    this.tracer.maxSamples = target
    this.accumulating = true
    this.state = 'tracing'
  }

  /** How far the image on screen has come: the samples behind it, of the view's target. */
  progress() {
    return { shown: this.denoising ? this.shownSamples : this.samples, target: this.target }
  }

  /** True once the image on screen holds at least `samples` and has fully faded in. */
  ready(samples: number) {
    const shown = this.denoising ? this.shownSamples : this.samples
    return (shown >= samples || this.state === 'converged') && this.view().t >= 1
  }

  halt() {
    // Keep what this view accumulated for the next one, under what it was traced of: scans that
    // arrived meanwhile are new to the next view, not to this one. Queued after any batch still in
    // flight.
    if (this.traced && this.frames > 0 && (this.state === 'tracing' || this.state === 'converged'))
      this.history.store(this.renderer, this.backend, this.gbuffer, this.traced)
    this.epoch++
    this.measuring = false
    this.passes = 1
    this.state = 'off'
    this.samples = 0
    this.running = null
    for (const denoiser of this.denoisers) denoiser.reset()
  }

  /**
   * Loads the denoiser's network now, so the first image does not: its weights download and are
   * repacked on the main thread, which otherwise lands just as the view first rests. Both denoisers
   * share the one network (shareUNets), so loading it for one loads it for both. Never rejects: a
   * network that fails to load fails again, as before, at the first denoise.
   */
  prepareDenoiser() {
    const denoiser = this.denoisers[0] as unknown as
      { _initUNet?: (aux: boolean) => Promise<unknown> } | undefined
    if (!denoiser?._initUNet) return Promise.resolve()
    // The tracer denoises with its guides (albedo and normal): the auxiliary network.
    return denoiser._initUNet(true).then(
      () => undefined,
      () => undefined,
    )
  }

  /**
   * Frees what a view that has stopped tracing can do without, keeping what is slow to make again:
   * the views traced so far (history), the denoiser's network and images, the snapshot and the
   * guides go; the tracer, its captured scene (BVH, atlas) and its compiled kernels stay, so the
   * next start needs no long capture. The next `begin` starts unseeded and loads the network again.
   */
  trim() {
    if (this.state !== 'off') return
    this.history.clear()
    this.traced = null
    this.snapshot?.dispose()
    this.snapshot = null
    for (const denoiser of this.denoisers) denoiser.dispose()
    this.gbuffer.dispose()
  }

  /** Forces the next `begin` to re-capture the whole scene (the stills', as scans arrive). */
  invalidate() {
    this.signature = -1
    this.captured = null
    this.scans++
  }

  /**
   * Scans arrived: the next `begin` reads the materials again, keeping the captured meshes and
   * their BVH unless the scene changed shape meanwhile, or the scans outgrow the textures its
   * kernels were compiled for (then it captures the scene again). Views traced before count as of
   * other surfaces.
   */
  texturesChanged() {
    this.materialsStale = true
    this.scans++
  }

  dispose() {
    this.epoch++
    this.state = 'off'
    this.tracer.dispose()
    this.sink.dispose()
    this.snapshot?.dispose()
    this.gbuffer.dispose()
    this.history.dispose()
    this.adaptive.dispose()
    for (const denoiser of this.denoisers) denoiser.dispose()
  }
}
