/**
 * The page scripts/convergence.mjs drives: three-gpu-pathtracer, as the app configures it, tracing
 * a small gym-like interior (a room with a row of ceiling spots, an area wash, equipment boxes and a
 * window to the sky) on whatever WebGPU adapter the browser has (SwiftShader, headless).
 *
 * `window.converge(variant)` traces the scene to a reference and to each checkpoint and returns
 * the root-mean-square error of each checkpoint against the reference, on luminance relative to
 * the reference's mean. A variant names the tracer settings under test.
 */
import {
  BoxGeometry,
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  RectAreaLight,
  RenderTarget,
  RGBAFormat,
  Scene,
  SpotLight,
  WebGPURenderer,
  type StorageTexture,
  type Texture,
} from 'three/webgpu'
import {
  RANDOM_BLUE_DITHER,
  RANDOM_PCG,
  RANDOM_SOBOL,
  WebGPUPathTracer,
} from 'three-gpu-pathtracer/webgpu'

export type Variant = {
  /** The tracer's random strategy. */
  random?: 'blue' | 'sobol' | 'pcg'
  /** Tracer property overrides (patched features under test). */
  tracer?: Record<string, unknown>
  /** The camera: 'room' (the room from its front) or 'equipment' (close to the boxes). */
  view?: 'room' | 'equipment'
  width?: number
  height?: number
  /** Samples per pixel to report the error at. */
  checkpoints?: number[]
  /** Samples per pixel of the reference, traced with the default settings. */
  reference?: number
}

declare global {
  interface Window {
    converge: (variants: Variant[]) => Promise<unknown>
  }
}

/** The few WebGPU calls the page makes itself (the project does not ship WebGPU's types). */
type Device = {
  queue: {
    onSubmittedWorkDone: () => Promise<void>
    writeTexture: (...args: unknown[]) => void
  }
}
type Backend = {
  device: Device
  get: (t: Texture) => { texture?: unknown }
  copyTextureToBuffer: (
    t: StorageTexture,
    x: number,
    y: number,
    w: number,
    h: number,
    face: number,
  ) => Promise<Float32Array>
}
const backendOf = (renderer: WebGPURenderer) => renderer.backend as unknown as Backend

// This Chromium predates the texture-view swizzle three r186 passes on some views.
const gpuTexture = (globalThis as unknown as { GPUTexture: { prototype: Record<string, unknown> } })
  .GPUTexture.prototype
const createView = gpuTexture.createView as (this: unknown, descriptor?: object) => unknown
gpuTexture.createView = function (this: unknown, descriptor?: Record<string, unknown>) {
  if (descriptor && 'swizzle' in descriptor) {
    const copy = { ...descriptor }
    delete copy.swizzle
    return createView.call(this, copy)
  }
  return createView.call(this, descriptor)
}

function sky() {
  const width = 64
  const height = 32
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const up = 1 - y / height
      const i = (y * width + x) * 4
      data.set([0.5 + up * 0.6, 0.65 + up * 0.6, 0.9 + up * 0.8, 1], i)
    }
  // As the app's skies are (pathtrace.ts environmentTexture): filtered, so the tracer's kernels
  // get a sampler for it.
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType)
  texture.mapping = EquirectangularReflectionMapping
  texture.minFilter = texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

function gym() {
  const scene = new Scene()
  scene.environment = sky()
  scene.background = scene.environment
  const matte = (hex: string, roughness = 0.8) =>
    new MeshStandardMaterial({ color: new Color(hex), roughness, metalness: 0 })
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: string) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), matte(hex))
    mesh.position.set(x, y + h / 2, z)
    scene.add(mesh)
    return mesh
  }
  const W = 20
  const D = 10
  const H = 4
  // Floor, ceiling, walls (a slab each, so both faces are solid); the right wall has a window.
  box(W, 0.1, D, 0, -0.1, 0, '#8a8178')
  box(W, 0.1, D, 0, H, 0, '#e8e4dc')
  box(W, H, 0.1, 0, 0, -D / 2, '#d9d3c8')
  box(0.1, H, D, -W / 2, 0, 0, '#d9d3c8')
  box(0.1, H, 3, W / 2, 0, -3.5, '#d9d3c8')
  box(0.1, H, 3, W / 2, 0, 3.5, '#d9d3c8')
  box(0.1, 1, 4, W / 2, 0, 0, '#d9d3c8')
  box(0.1, 0.6, 4, W / 2, H - 0.6, 0, '#d9d3c8')
  // Equipment: racks and benches in the middle of the room, lit from every side.
  for (const x of [-6, -2, 2, 6]) {
    box(0.15, 2.4, 0.15, x - 0.6, 0, -1.4, '#2b2b2e')
    box(0.15, 2.4, 0.15, x + 0.6, 0, -1.4, '#2b2b2e')
    box(1.4, 0.12, 0.6, x, 1.4, -1.4, '#3a3a3e')
    box(1.6, 0.5, 0.5, x, 0, 1.2, '#6b4a3a')
  }
  // Two rows of downlights, as the slatted interiors have (InteriorLights.tsx).
  for (const x of [-8, -4, 0, 4, 8])
    for (const z of [-1.3, 1.5]) {
      const spot = new SpotLight('#ffe2c2', 18, 0, 0.78, 0.85, 2)
      spot.position.set(x, H - 0.05, z)
      spot.target.position.set(x, 0, z - 0.4)
      scene.add(spot, spot.target)
    }
  // The back-wall cove: an area light washing the wall.
  const wash = new RectAreaLight('#ffe2c2', 3, 16, 0.3)
  wash.position.set(0, H - 0.3, -D / 2 + 0.3)
  wash.lookAt(0, H - 1.5, -D / 2)
  scene.add(wash)
  scene.updateMatrixWorld(true)
  return scene
}

function camera(view: Variant['view'], aspect: number) {
  const lens = new PerspectiveCamera(view === 'equipment' ? 50 : 70, aspect, 0.1, 100)
  if (view === 'equipment') {
    lens.position.set(-3.5, 1.8, 3.6)
    lens.lookAt(0, 0.9, -0.5)
  } else {
    lens.position.set(-8.5, 2.6, 4.6)
    lens.lookAt(2, 1.2, -2)
  }
  lens.updateMatrixWorld()
  return lens
}

/** Uploads zeros to an rgba16float 3D texture so it counts as initialized (pathtrace.ts). */
function zeroFill(renderer: WebGPURenderer, texture: Texture) {
  const { width, height, depth } = texture.image as { width: number; height: number; depth: number }
  renderer.initTexture(texture)
  const backend = backendOf(renderer)
  const target = backend.get(texture).texture
  if (!target) return
  backend.device.queue.writeTexture(
    { texture: target },
    new Uint16Array(width * height * depth * 4),
    { bytesPerRow: width * 8, rowsPerImage: height },
    [width, height, depth],
  )
}

const STRATEGIES = { blue: RANDOM_BLUE_DITHER, sobol: RANDOM_SOBOL, pcg: RANDOM_PCG }

async function luminance(renderer: WebGPURenderer, target: StorageTexture) {
  const { width, height } = target.image as { width: number; height: number }
  const data = await backendOf(renderer).copyTextureToBuffer(target, 0, 0, width, height, 0)
  const stride = (Math.ceil((width * 16) / 256) * 256) / 4
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * 4
      out[y * width + x] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
  return out
}

const sink = new RenderTarget(1, 1)

/** Traces until every pixel holds `samples`, returning the luminance then. */
async function trace(
  renderer: WebGPURenderer,
  tracer: WebGPUPathTracer,
  samples: number,
): Promise<Float32Array> {
  const device = backendOf(renderer).device
  // Headless Chromium cannot present to a canvas (the device is lost): the tracer's own display
  // pass draws off screen, as PathTraceSession's does.
  renderer.setRenderTarget(sink)
  for (;;) {
    const counts = await tracer.getSampleCountsAsync()
    if (counts.min >= samples) break
    tracer.renderSample()
    await device.queue.onSubmittedWorkDone()
  }
  return luminance(renderer, tracer.target as StorageTexture)
}

function rmse(a: Float32Array, reference: Float32Array) {
  let mean = 0
  for (const v of reference) mean += v
  mean /= reference.length
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    // Clamped like a display, so a firefly does not stand for the whole image.
    const d = Math.min(a[i], 8 * mean) - Math.min(reference[i], 8 * mean)
    sum += d * d
  }
  return Math.sqrt(sum / a.length) / mean
}

let shared: { renderer: WebGPURenderer; scene: Scene } | undefined
/** References traced so far, kept across calls (repeats compare against the same one). */
const references = new Map<string, Float32Array>()

window.converge = async (variants) => {
  if (!shared) {
    const renderer = new WebGPURenderer({
      canvas: document.createElement('canvas'),
      antialias: false,
    })
    await renderer.init()
    shared = { renderer, scene: gym() }
  }
  const { renderer, scene } = shared
  const results: unknown[] = []
  for (const variant of variants) {
    const width = variant.width ?? 64
    const height = variant.height ?? 40
    const view = variant.view ?? 'room'
    renderer.setSize(width, height, false)
    const lens = camera(view, width / height)
    const make = (random: Variant['random'], overrides: Record<string, unknown> = {}) => {
      const tracer = new WebGPUPathTracer(renderer)
      // As the 360° view configures it (pathtrace.ts, liveProfile.ts).
      tracer.maxBounces = 7
      tracer.maxTransparentBounces = 12
      tracer.filterGlossyFactor = 0.5
      tracer.dynamicLowRes = false
      tracer.renderDelay = 0
      tracer.minSamples = 0
      tracer.maxSamples = 1 << 20
      tracer.stableNoise = false
      // As PathTraceSession does: keep the GGX energy table (3D) out of mip generation and
      // initialized, or Dawn zero-fills it through a 2D view and every dispatch fails.
      const table = (tracer as unknown as { material: { turquinTexture: Texture } }).material
        .turquinTexture as Texture & { mipmapsAutoUpdate: boolean }
      table.generateMipmaps = false
      table.mipmapsAutoUpdate = false
      zeroFill(renderer, table)
      Object.assign(tracer, overrides)
      tracer.setRandom(STRATEGIES[random ?? 'blue'])
      tracer.setScene(scene, lens)
      tracer.reset()
      return tracer
    }
    const key = `${view}:${width}x${height}:${variant.reference ?? 1024}`
    let reference = references.get(key)
    if (!reference) {
      const tracer = make('pcg')
      reference = await trace(renderer, tracer, variant.reference ?? 1024)
      tracer.dispose()
      references.set(key, reference)
    }
    const tracer = make(variant.random, variant.tracer)
    const errors: Record<number, number> = {}
    const started = performance.now()
    for (const samples of variant.checkpoints ?? [2, 8, 32, 128]) {
      errors[samples] = rmse(await trace(renderer, tracer, samples), reference)
    }
    tracer.dispose()
    results.push({ variant, errors, seconds: (performance.now() - started) / 1000 })
  }
  return results
}
