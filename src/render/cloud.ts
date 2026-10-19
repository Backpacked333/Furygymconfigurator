import {
  DataUtils,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type InstancedMesh,
  type InterleavedBufferAttribute,
  type Light,
  type Material,
  type Mesh,
  type RectAreaLight,
  type Scene,
  type SpotLight,
  type Texture,
} from 'three/webgpu'
import type { SkyLook } from '../lib/visuals'
import { environmentTexture, lookKey, preparePathTraceScene, sunLight } from './pathtrace'
import { bench } from './bench'
import { fingerprint } from './hash'
import { stillInstances } from './instances'
import { RENDER_SESSION, renderSession, warmCloud, warmth } from './renderSession'
import { cloudUrl } from './traceStatus'
import type { CloudWork } from './workProgress'

export { cloudUrl, renderSession, warmCloud, warmth }
export { fingerprint }

/**
 * Off-device rendering: the gallery's stills are rendered by Blender Cycles on a cloud GPU with
 * hardware ray tracing (render-server/), and come back finished (stills.ts).
 *
 * The browser describes the same path-traced form of the scene the local tracer captures
 * (preparePathTraceScene): meshes, physically based materials, textures, lights, and the sky.
 * Bulky data travels as blobs named by the SHA-256 of their content: geometry, instance
 * matrices, the sky map, and texture files. The server keeps them, so a new camera angle or a
 * material edit sends only the small JSON description, and a blob is uploaded only when the
 * server answers that it is missing (409). Texture bytes are uploaded by the browser too.
 * The still comes back finished (exposure, bloom, tone mapping) as WebP, at the exposure the live
 * view is shown at (visuals.ts exposureAt), with no gain between the two (stills.ts STILL_GAIN).
 *
 * The description names nothing by the page's own ids: objects, materials and textures are keyed
 * by their content and listed in key order, so the same design serializes to the same bytes on
 * every page load and for every visitor, and the server's frame cache (keyed by the scene's
 * SHA-256) answers a design anyone has viewed before.
 */

/** `?traceStats=1` logs each cloud render's timings. */
const TRACE_STATS = new URLSearchParams(window.location.search).get('traceStats') === '1'

/** Uploads in flight at once. */
const UPLOADS = 4
/**
 * A still that has not come after this long, beyond twice its own time limit and the longest of
 * the session's other open frames (its GPU renders one at a time, and an export ahead of it takes
 * up to a minute), is taken as a busy server: the session asks again after a
 * backoff rather than holding a place open for a connection that may be dead.
 */
export const FRAME_TIMEOUT_MS = 20_000

/**
 * One signal for several, aborted as soon as any of them is, with the reason of the first. Where
 * `AbortSignal.any` is missing the listeners are kept until `done` is called, so a long-lived
 * signal (a whole design's) is not left with one listener per frame.
 */
function anySignal(signals: AbortSignal[]): { signal: AbortSignal; done: () => void } {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(signals), done() {} }
  const controller = new AbortController()
  const listeners: (() => void)[] = []
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const listener = () => controller.abort(signal.reason)
    signal.addEventListener('abort', listener, { once: true })
    listeners.push(() => signal.removeEventListener('abort', listener))
  }
  return {
    signal: controller.signal,
    done() {
      for (const remove of listeners) remove()
    },
  }
}

// --- Scene description ----------------------------------------------------------------------

export type Vec3 = [number, number, number]

export type CloudTexture = {
  blob: string
  /** Where the server may fetch the file itself (the site's own assets). */
  url?: string
  srgb: boolean
  wrap: 'repeat' | 'mirror' | 'clamp'
  /** three.js UV transform, column-major 3x3. */
  matrix: number[]
}

export type CloudMaterial = {
  color: Vec3
  roughness: number
  metalness: number
  emissive: Vec3
  emissiveIntensity: number
  transmission: number
  ior: number
  clearcoat: number
  clearcoatRoughness: number
  sheen: number
  sheenRoughness: number
  sheenColor: Vec3
  specularIntensity: number
  specularColor: Vec3
  opacity: number
  transparent: boolean
  alphaTest: number
  side: number
  normalScale: [number, number]
  maps: Partial<Record<MapSlot, string>>
}

export type CloudLight =
  | {
      type: 'area'
      shape: 'rect' | 'ellipse'
      matrix: number[]
      width: number
      height: number
      color: Vec3
      intensity: number
    }
  | {
      type: 'spot'
      position: Vec3
      direction: Vec3
      angle: number
      penumbra: number
      radius: number
      color: Vec3
      intensity: number
    }
  | { type: 'point'; position: Vec3; radius: number; color: Vec3; intensity: number }
  | { type: 'sun'; direction: Vec3; angle: number; color: Vec3; irradiance: number }

export type CloudObject = {
  id: string
  geometry: string
  materials: string[]
  matrix: number[]
  instances?: string
}

export type CloudScene = {
  objects: CloudObject[]
  materials: Record<string, CloudMaterial>
  textures: Record<string, CloudTexture>
  lights: CloudLight[]
  environment: { blob: string } | null
}

type MapSlot = 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'emissiveMap' | 'alphaMap'
const MAP_SLOTS: MapSlot[] = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'alphaMap',
]

/** Raw bytes of a blob, produced on demand (uploads are rare, so nothing is kept around). */
type BlobSource = () => Promise<Uint8Array>
type HashedBlob = { hash: string; source: BlobSource; bytes: number }

/** A captured scene: its description and where each referenced blob's bytes come from. */
export type CapturedScene = { scene: CloudScene; blobs: Map<string, BlobSource> }

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** Hashes a blob once; the bytes are dropped and re-made from `source` if an upload needs them. */
async function hashed(source: BlobSource): Promise<HashedBlob> {
  const bytes = await source()
  return { hash: await sha256(bytes), source, bytes: bytes.byteLength }
}

/** JSON with every object's keys in order, so the same content is always the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const fields = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** A record with its keys in order, so it serializes the same however it was filled. */
function sorted<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(record).sort()) out[key] = record[key]
  return out
}

// Geometry -------------------------------------------------------------------------------------

function floats(attribute: BufferAttribute | InterleavedBufferAttribute, size: number) {
  const plain = attribute as BufferAttribute
  if (
    !(attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute &&
    plain.array instanceof Float32Array &&
    plain.itemSize === size &&
    !plain.normalized
  )
    return plain.array.subarray(0, attribute.count * size)
  const out = new Float32Array(attribute.count * size)
  for (let i = 0; i < attribute.count; i++) {
    out[i * size] = attribute.getX(i)
    out[i * size + 1] = attribute.getY(i)
    if (size > 2) out[i * size + 2] = attribute.getZ(i)
  }
  return out
}

/** The FRG1 blob of a geometry (render-server/fury_render/protocol.py). */
export function encodeGeometry(geometry: BufferGeometry): Uint8Array {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')
  const index = geometry.getIndex()
  const count = position.count
  const parts: Uint8Array[] = []
  let offset = 0
  const add = (array: Float32Array | Uint32Array) => {
    const at = offset
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    parts.push(bytes)
    offset += bytes.byteLength
    return at
  }
  const indexCount = index ? index.count : count
  const header = {
    count,
    position: add(floats(position, 3)),
    normal: normal ? add(floats(normal, 3)) : null,
    uv: uv ? add(floats(uv, 2)) : null,
    index: index ? { offset: 0, count: index.count } : null,
    groups: geometry.groups.map((g) => [
      g.start,
      Math.min(g.count, indexCount - g.start),
      g.materialIndex ?? 0,
    ]),
  }
  if (index && header.index) {
    header.index.offset = add(
      index.array instanceof Uint32Array
        ? index.array.subarray(0, index.count)
        : Uint32Array.from(index.array.subarray(0, index.count)),
    )
  }
  let text = new TextEncoder().encode(JSON.stringify(header))
  if (text.byteLength % 4) {
    const padded = new Uint8Array(text.byteLength + 4 - (text.byteLength % 4)).fill(32)
    padded.set(text)
    text = padded
  }
  const out = new Uint8Array(8 + text.byteLength + offset)
  out.set([0x46, 0x52, 0x47, 0x31]) // FRG1
  new DataView(out.buffer).setUint32(4, text.byteLength, true)
  out.set(text, 8)
  let at = 8 + text.byteLength
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

function geometryVersion(geometry: BufferGeometry) {
  const parts = [geometry.index?.version ?? -1, geometry.groups.length]
  for (const name of ['position', 'normal', 'uv']) {
    const a = geometry.getAttribute(name) as BufferAttribute | undefined
    parts.push(a ? (a.version ?? 0) + a.count * 7 : -1)
  }
  return parts.join(',')
}

const geometryBlobs = new WeakMap<BufferGeometry, { version: string; blob: Promise<HashedBlob> }>()
function geometryBlob(geometry: BufferGeometry) {
  const version = geometryVersion(geometry)
  const cached = geometryBlobs.get(geometry)
  if (cached && cached.version === version) return cached.blob
  const blob = hashed(async () => encodeGeometry(geometry))
  geometryBlobs.set(geometry, { version, blob })
  return blob
}

/** The FRI1 blob of an instanced mesh's local matrices, copied now since they may change. */
export function encodeInstances(matrices: Float32Array, count: number) {
  const out = new Uint8Array(8 + count * 64)
  out.set([0x46, 0x52, 0x49, 0x31]) // FRI1
  new DataView(out.buffer).setUint32(4, count, true)
  new Float32Array(out.buffer, 8, count * 16).set(matrices.subarray(0, count * 16))
  return out
}

const instanceBlobs = new WeakMap<object, { version: string; blob: Promise<HashedBlob> }>()
function instanceBlob(mesh: InstancedMesh) {
  // Every instance, however many the raster tier draws (instances.ts).
  const count = stillInstances(mesh)
  const version = `${mesh.instanceMatrix.version},${count}`
  const cached = instanceBlobs.get(mesh.instanceMatrix)
  if (cached && cached.version === version) return cached.blob
  const bytes = encodeInstances(mesh.instanceMatrix.array as Float32Array, count)
  const blob = hashed(async () => bytes)
  instanceBlobs.set(mesh.instanceMatrix, { version, blob })
  return blob
}

// Sky ------------------------------------------------------------------------------------------

/** The FRE1 blob of an equirect radiance map: half-float RGB, rows from v = 0 upward. */
export function encodeSky(data: Float32Array, width: number, height: number) {
  const out = new Uint8Array(12 + width * height * 6)
  out.set([0x46, 0x52, 0x45, 0x31]) // FRE1
  const view = new DataView(out.buffer)
  view.setUint32(4, width, true)
  view.setUint32(8, height, true)
  const half = new Uint16Array(out.buffer, 12, width * height * 3)
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    half[j] = DataUtils.toHalfFloat(data[i * 4])
    half[j + 1] = DataUtils.toHalfFloat(data[i * 4 + 1])
    half[j + 2] = DataUtils.toHalfFloat(data[i * 4 + 2])
  }
  return out
}

const skyBlobs = new Map<string, Promise<HashedBlob>>()
function skyBlob(look: SkyLook) {
  const key = lookKey(look)
  let blob = skyBlobs.get(key)
  if (!blob) {
    const texture = environmentTexture(look)
    const { data, width, height } = texture.image as {
      data: Float32Array
      width: number
      height: number
    }
    const bytes = encodeSky(data, width, height)
    blob = hashed(async () => bytes)
    if (skyBlobs.size >= 4) skyBlobs.delete(skyBlobs.keys().next().value!)
    skyBlobs.set(key, blob)
  }
  return blob
}

// Textures -------------------------------------------------------------------------------------

const imageBlobs = new WeakMap<object, { version: number; blob: Promise<HashedBlob | null> }>()
/** Canvases encoded as PNG so far: `?traceStats=1` counts the ones a capture paid for. */
let encoded = 0

async function pngOf(image: CanvasImageSource & { width: number; height: number }) {
  const canvas = new OffscreenCanvas(image.width, image.height)
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

/**
 * A texture's image as a file: the scan it was decoded from (materials.ts keeps it), fetched
 * from its URL when it has one, else encoded as PNG. A scan's file is a few MB of WebP and
 * already in memory; the PNG of its decoded bitmap would be tens of MB, encoded on the main
 * thread and hashed, for every scan, on the page's first capture.
 */
function textureBlob(texture: Texture): { blob: Promise<HashedBlob | null>; url?: string } {
  const image = texture.source.data as unknown
  const key = texture.source as object
  const cached = imageBlobs.get(key)
  const url =
    typeof HTMLImageElement !== 'undefined' &&
    image instanceof HTMLImageElement &&
    /^https?:/.test(image.currentSrc || image.src)
      ? new URL(image.currentSrc || image.src, window.location.href).href
      : undefined
  if (cached && cached.version === texture.source.version) return { blob: cached.blob, url }
  const scan = texture.userData.scan as unknown
  let source: BlobSource | null = null
  if (typeof Blob !== 'undefined' && scan instanceof Blob) {
    source = async () => new Uint8Array(await scan.arrayBuffer())
  } else if (url) {
    source = async () => new Uint8Array(await (await fetch(url)).arrayBuffer())
  } else if (
    (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) ||
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement)
  ) {
    const drawable = image as CanvasImageSource & { width: number; height: number }
    // Canvases may be redrawn later; encode their pixels as they are now.
    const now = pngOf(drawable)
    encoded++
    source = () => now
  }
  const blob = source ? hashed(source).catch(() => null) : Promise.resolve(null)
  imageBlobs.set(key, { version: texture.source.version, blob })
  return { blob, url }
}

function wrapOf(texture: Texture): CloudTexture['wrap'] {
  // RepeatWrapping 1000, ClampToEdgeWrapping 1001, MirroredRepeatWrapping 1002
  const modes = [texture.wrapS, texture.wrapT]
  if (modes.includes(1000)) return 'repeat'
  if (modes.includes(1002)) return 'mirror'
  return 'clamp'
}

// Materials ------------------------------------------------------------------------------------

const color = (c: { r: number; g: number; b: number } | undefined, fallback: Vec3): Vec3 =>
  c ? [c.r, c.g, c.b] : fallback

function materialParams(
  material: Material,
  textureKey: (texture: Texture) => string,
): CloudMaterial {
  const m = material as Material & Record<string, unknown>
  const num = (name: string, fallback: number) =>
    typeof m[name] === 'number' && Number.isFinite(m[name]) ? (m[name] as number) : fallback
  const rgb = (name: string, fallback: Vec3) =>
    color(m[name] as { r: number; g: number; b: number } | undefined, fallback)
  const maps: CloudMaterial['maps'] = {}
  for (const slot of MAP_SLOTS) {
    const texture = m[slot] as Texture | null | undefined
    if (texture?.isTexture && texture.source?.data) maps[slot] = textureKey(texture)
  }
  const scale = m.normalScale as Vector2 | undefined
  return {
    color: rgb('color', [1, 1, 1]),
    roughness: num('roughness', 1),
    metalness: num('metalness', 0),
    emissive: rgb('emissive', [0, 0, 0]),
    emissiveIntensity: num('emissiveIntensity', 1),
    transmission: num('transmission', 0),
    ior: num('ior', 1.5),
    clearcoat: num('clearcoat', 0),
    clearcoatRoughness: num('clearcoatRoughness', 0),
    sheen: num('sheen', 0),
    sheenRoughness: num('sheenRoughness', 1),
    sheenColor: rgb('sheenColor', [0, 0, 0]),
    specularIntensity: num('specularIntensity', 1),
    specularColor: rgb('specularColor', [1, 1, 1]),
    opacity: num('opacity', 1),
    transparent: Boolean(m.transparent),
    alphaTest: num('alphaTest', 0),
    side: num('side', 0),
    normalScale: scale ? [scale.x, scale.y] : [1, 1],
    maps,
  }
}

// Lights ---------------------------------------------------------------------------------------

const v3 = (v: Vector3): Vec3 => [v.x, v.y, v.z]

function lightRecord(light: Light): CloudLight | null {
  const c = color(light.color, [1, 1, 1])
  if ((light as RectAreaLight).isRectAreaLight) {
    const area = light as RectAreaLight & { isCircular?: boolean }
    return {
      type: 'area',
      shape: area.isCircular ? 'ellipse' : 'rect',
      matrix: Array.from(area.matrixWorld.elements),
      width: area.width,
      height: area.height,
      color: c,
      intensity: area.intensity,
    }
  }
  if ((light as SpotLight).isSpotLight) {
    const spot = light as SpotLight & { radius?: number }
    const position = spot.getWorldPosition(new Vector3())
    const target = spot.target.getWorldPosition(new Vector3())
    return {
      type: 'spot',
      position: v3(position),
      direction: v3(target.sub(position).normalize()),
      angle: spot.angle,
      penumbra: spot.penumbra,
      radius: spot.radius ?? 0,
      color: c,
      intensity: spot.intensity,
    }
  }
  if ((light as Light & { isPointLight?: boolean }).isPointLight) {
    const point = light as Light & { radius?: number }
    return {
      type: 'point',
      position: v3(point.getWorldPosition(new Vector3())),
      radius: point.radius ?? 0,
      color: c,
      intensity: light.intensity,
    }
  }
  return null
}

// Capture --------------------------------------------------------------------------------------

/**
 * Describes the scene as the local path tracer would see it. The scene is read synchronously
 * while in its path-traced form; hashing blobs finishes asynchronously, and the names come last:
 * a texture is named by its file's hash (and how it is applied), a material by its values with
 * those names in, an object by its geometry, instances, materials and placement. Two of anything
 * alike are one, objects are listed by name and the records by key, so the description is the
 * same from any page load (uuids would differ every time) and the server's frame cache hits.
 *
 * Everything read from the scene is read before the first await, in the caller's task: the
 * stills' prefetch puts a sibling design's surfaces on for the call alone (siblings.ts).
 */
export async function captureScene(scene: Scene, look: SkyLook): Promise<CapturedScene> {
  // Timed by phase for `?traceStats=1`: which of them the first capture's seconds go to decides
  // what to move off the main thread.
  const started = performance.now()
  const phases: string[] = []
  let phased = started
  const phase = (name: string) => {
    const now = performance.now()
    phases.push(`${name} ${Math.round(now - phased)}`)
    phased = now
  }
  const environment = environmentTexture(look)
  phase('sky map')
  const meshes: {
    materials: Material[]
    matrix: number[]
    geometry: Promise<HashedBlob>
    instances?: Promise<HashedBlob>
  }[] = []
  // Read while the scene is in its path-traced form; named once the textures are hashed.
  const params = new Map<Material, CloudMaterial>()
  const textureRefs = new Map<Texture, string>()
  const lights: CloudLight[] = []
  const placeholder = (texture: Texture) => {
    let name = textureRefs.get(texture)
    if (!name) {
      name = `t${textureRefs.size}`
      textureRefs.set(texture, name)
    }
    return name
  }
  const encodedBefore = encoded
  const restore = preparePathTraceScene(scene, look, environment)
  try {
    scene.updateMatrixWorld()
    scene.traverseVisible((object) => {
      const light = object as Light
      if (light.isLight) {
        if (light.userData.sun) return
        const record = lightRecord(light)
        if (record && light.intensity > 0) lights.push(record)
        return
      }
      const mesh = object as Mesh
      if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) return
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list)
        if (!params.has(material)) params.set(material, materialParams(material, placeholder))
      const instanced = mesh as InstancedMesh
      if (instanced.isInstancedMesh && stillInstances(instanced) === 0) return
      meshes.push({
        materials: list,
        matrix: Array.from(mesh.matrixWorld.elements),
        geometry: geometryBlob(mesh.geometry),
        instances: instanced.isInstancedMesh ? instanceBlob(instanced) : undefined,
      })
    })
  } finally {
    restore()
  }
  phase('scene')
  const sun = sunLight(look)
  if (sun)
    lights.push({
      type: 'sun',
      direction: sun.direction,
      angle: sun.angularRadius * 2,
      color: sun.color,
      irradiance: sun.irradiance,
    })

  const blobs = new Map<string, BlobSource>()
  let bytes = 0
  const keep = (blob: HashedBlob) => {
    if (!blobs.has(blob.hash)) bytes += blob.bytes
    blobs.set(blob.hash, blob.source)
    return blob.hash
  }
  // Textures, named by their content and how they are applied.
  const textures: Record<string, CloudTexture> = {}
  const textureKeys = new Map<string, string>()
  await Promise.all(
    [...textureRefs].map(async ([texture, name]) => {
      const { blob, url } = textureBlob(texture)
      const resolved = await blob
      if (!resolved) return
      texture.updateMatrix()
      const record: CloudTexture = {
        blob: keep(resolved),
        ...(url ? { url } : {}),
        srgb: texture.colorSpace === SRGBColorSpace,
        wrap: wrapOf(texture),
        matrix: Array.from(texture.matrix.elements),
      }
      // The URL is only where the file may be fetched from: not what the texture is.
      const key = fingerprint(
        stableJson({
          blob: record.blob,
          srgb: record.srgb,
          wrap: record.wrap,
          matrix: record.matrix,
        }),
      )
      textureKeys.set(name, key)
      textures[key] = record
    }),
  )
  phase(
    `textures${encoded > encodedBefore ? ` (${encoded - encodedBefore} canvases encoded)` : ''}`,
  )
  // Materials, named by their values with the textures' names in; one whose texture could not be
  // read falls back to its plain values.
  const materials: Record<string, CloudMaterial> = {}
  const materialKeys = new Map<Material, string>()
  for (const [material, record] of params) {
    for (const slot of MAP_SLOTS) {
      const name = record.maps[slot]
      if (!name) continue
      const key = textureKeys.get(name)
      if (key) record.maps[slot] = key
      else delete record.maps[slot]
    }
    const key = fingerprint(stableJson(record))
    materials[key] = record
    materialKeys.set(material, key)
  }
  // Objects, named by everything about them; two alike are one.
  const objects = new Map<string, CloudObject>()
  for (const object of await Promise.all(
    meshes.map(async ({ materials: list, matrix, geometry, instances }) => {
      const keys = list.map((material) => materialKeys.get(material)!)
      const record: CloudObject = {
        id: '',
        geometry: keep(await geometry),
        materials: keys,
        matrix,
        ...(instances ? { instances: keep(await instances) } : {}),
      }
      record.id = fingerprint(
        [record.geometry, record.instances ?? '', keys.join(','), matrix.join(',')].join('|'),
      )
      return record
    }),
  ))
    objects.set(object.id, object)
  phase('geometry')
  const sky = keep(await skyBlob(look))
  phase('sky blob')
  const byText = (a: unknown, b: unknown) => {
    const [x, y] = [stableJson(a), stableJson(b)]
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (TRACE_STATS)
    console.info(
      `[cloud] scene captured in ${Math.round(performance.now() - started)} ms (${phases.join(', ')} ms): ${objects.size} objects, ${blobs.size} blobs, ${(bytes / 1e6).toFixed(1)} MB`,
    )
  return {
    scene: {
      objects: [...objects.keys()].sort().map((id) => objects.get(id)!),
      materials: sorted(materials),
      textures: sorted(textures),
      lights: [...lights].sort(byText),
      environment: { blob: sky },
    },
    blobs,
  }
}

// Transport ------------------------------------------------------------------------------------

async function gzip(bytes: Uint8Array) {
  const stream = new Response(bytes as BodyInit).body!.pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export class Superseded extends Error {}
/** The server or gateway is busy (rate limit, full queue): worth trying again shortly. */
export class Busy extends Error {}
/** The server answered a frame request with a view's raw image: it predates finished frames. */
export class Outdated extends Error {}
/** Every cloud GPU is in use by other visitors: this page renders on its own device. */
export class Full extends Error {}

export type CloudCamera = { matrix: number[]; fov: number; near: number; far: number }

/** Client of one render server. */
export class CloudClient {
  readonly url: string
  private readonly session = Math.random().toString(36).slice(2)
  /** Uploads in flight, shared by frames that need the same blob (a still and its thumbnail). */
  private readonly uploading = new Map<string, Promise<void>>()
  /** The frames open, by time limit: the session's GPU may render any of them ahead of another. */
  private readonly open = new Set<{ timeLimit: number }>()

  constructor(url: string) {
    this.url = url
  }

  private async put(key: string, blobs: Map<string, BlobSource>, signal: AbortSignal) {
    const source = blobs.get(key)
    if (!source) throw new Error(`server asked for an unknown blob ${key}`)
    const raw = await source()
    // Image files are compressed already.
    const isImage = raw[0] === 0x89 || raw[0] === 0xff || raw[0] === 0x52
    const body = isImage ? raw : await gzip(raw)
    const response = await fetch(`${this.url}/blobs/${key}?session=${RENDER_SESSION}`, {
      method: 'PUT',
      body: body as BodyInit,
      signal,
    })
    // Turned away for now (rate limit, full queue): the render that needs it is asked again later.
    if (response.status === 429 || response.status === 503)
      throw new Busy(`upload turned away (${response.status})`)
    if (!response.ok) throw new Error(`upload failed (${response.status})`)
  }

  private async upload(
    keys: string[],
    blobs: Map<string, BlobSource>,
    signal: AbortSignal,
    onProgress?: (work: CloudWork) => void,
  ) {
    const queue = [...keys]
    let completed = 0
    const report = () => onProgress?.({ stage: 'uploading', completed, total: keys.length })
    report()
    const worker = async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        const shared = this.uploading.get(key)
        if (shared) {
          try {
            await shared
            completed++
            report()
            continue
          } catch {
            // The other render gave up on it; upload it for this one.
            signal.throwIfAborted()
          }
        }
        const upload = this.put(key, blobs, signal).finally(() => {
          if (this.uploading.get(key) === upload) this.uploading.delete(key)
        })
        this.uploading.set(key, upload)
        await upload
        completed++
        report()
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOADS, keys.length) }, worker))
  }

  /**
   * A finished frame (a still of stills.ts): tone mapped, with bloom, as WebP. All
   * frames of one `generation` share a sequence number, so a newer generation (the design
   * changed) drops the ones still queued. A frame that takes too long to come (FRAME_TIMEOUT_MS
   * beyond twice its time limit and the longest other frame open) is given up as a busy server.
   */
  async frame(
    captured: CapturedScene,
    request: {
      camera: CloudCamera
      width: number
      height: number
      quality: { samples: number; threshold: number; timeLimit: number }
      finish: { exposure: number; gain: number }
      priority: number
      generation: number
      /** Frames on another channel never supersede these (the stage's, a prefetch, a bake). */
      channel?: string
    },
    signal: AbortSignal,
    onProgress?: (work: CloudWork) => void,
  ): Promise<StillFrame> {
    const start = performance.now()
    const opened = { timeLimit: request.quality.timeLimit }
    this.open.add(opened)
    // A timer of its own rather than AbortSignal.timeout, so it is cleared when the frame lands,
    // and set again at its deadline when a longer frame was opened since, which may render first.
    const clock = new AbortController()
    const budget = () => {
      let longest = 0
      for (const other of this.open)
        if (other !== opened) longest = Math.max(longest, other.timeLimit)
      return FRAME_TIMEOUT_MS + (2 * opened.timeLimit + longest) * 1000
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      const left = start + budget() - performance.now()
      if (left > 0) timer = setTimeout(arm, left)
      else clock.abort()
    }
    arm()
    const either = anySignal([signal, clock.signal])
    try {
      const response = await this.post(
        {
          session: `${this.session}${request.channel ?? 's'}`,
          seq: request.generation,
          kind: 'spin',
          priority: request.priority,
          output: 'frame',
          camera: request.camera,
          width: request.width,
          height: request.height,
          quality: request.quality,
          finish: request.finish,
        },
        captured,
        either.signal,
        onProgress,
      )
      // An older server ignores the frame fields and renders a view: a half-float image, not WebP.
      if (!(response.headers.get('content-type') ?? '').startsWith('image/'))
        throw new Outdated('the render server does not finish frames; redeploy it')
      const header = (name: string) => Number(response.headers.get(name) ?? 0)
      const renderer = response.headers.get('x-fury-renderer')
      onProgress?.({ stage: 'receiving' })
      const frame: StillFrame = {
        image: await response.blob(),
        cached: response.headers.get('x-cache') === 'hit',
        renderMs: header('x-render-ms'),
        finishMs: header('x-finish-ms'),
        totalMs: performance.now() - start,
        tracedKey: Number(response.headers.get('x-traced-key') ?? NaN),
        renderer: renderer === 'shared' || renderer === 'own' ? renderer : '',
      }
      bench.frame(frame)
      return frame
    } catch (error) {
      // The caller's own abort is theirs; the clock's is the server not answering in time.
      if (clock.signal.aborted && !signal.aborted)
        throw new Busy(`no frame within ${Math.round(performance.now() - start)} ms`)
      throw error
    } finally {
      clearTimeout(timer)
      this.open.delete(opened)
      either.done()
    }
  }

  /** Posts a render request, uploading whatever blobs the server asks for. */
  private async post(
    fields: object,
    captured: CapturedScene,
    signal: AbortSignal,
    onProgress?: (work: CloudWork) => void,
  ) {
    const encoded = new TextEncoder().encode(JSON.stringify({ ...fields, scene: captured.scene }))
    const payload = encoded.byteLength > 32 * 1024 ? await gzip(encoded) : encoded
    for (let attempt = 0; attempt < 3; attempt++) {
      // Timed from this attempt alone: the page's first request also uploads every blob first.
      const started = performance.now()
      onProgress?.({ stage: 'requesting' })
      const response = await fetch(`${this.url}/render?session=${RENDER_SESSION}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload as BodyInit,
        signal,
      })
      if (response.status === 409) {
        const answer = (await response.json()) as { missing?: string[]; superseded?: boolean }
        if (answer.superseded) throw new Superseded()
        if (answer.missing?.length) {
          await this.upload(answer.missing, captured.blobs, signal, onProgress)
          continue
        }
      }
      if (response.status === 503) {
        const answer = (await response.json().catch(() => null)) as { full?: boolean } | null
        if (answer?.full) throw new Full('every cloud GPU is in use')
      }
      if (response.status === 429 || response.status === 503)
        throw new Busy(`cloud renderer busy (${response.status})`)
      if (!response.ok) throw new Error(`cloud render failed (${response.status})`)
      // The first answer of the page tells the bench whether the cloud was warm or started.
      bench.answered({
        renderer: response.headers.get('x-fury-renderer') ?? '',
        totalMs: performance.now() - started,
      })
      return response
    }
    throw new Error('cloud render kept asking for uploads')
  }
}

/**
 * A finished frame as the server sent it (WebP), with the traced image's key: its mean log
 * luminance before finishing on a 48×30 grid (render-server finishing.py traced_key), for
 * diagnostics: the page meters nothing against it.
 */
export type StillFrame = {
  image: Blob
  cached: boolean
  /** The server's render and finishing (exposure, bloom, tone mapping, WebP) time. */
  renderMs: number
  finishMs: number
  /** The whole round trip as the browser saw it. */
  totalMs: number
  tracedKey: number
  /** Which renderer answered (X-Fury-Renderer): the session's own GPU or the shared warm one. */
  renderer: 'shared' | 'own' | ''
}
