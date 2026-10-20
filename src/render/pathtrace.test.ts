// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  RectAreaLight,
  Scene,
  StorageTexture,
  type Texture,
  type Vector2,
} from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { environmentRadiance, equirectRadiance, skyLook } from '../lib/visuals'
import { GBuffer, MultiViewHistory, ViewHistory, type HistoryKeys } from './history'
import {
  EARLY_MILESTONES,
  EXPORT_SAMPLES,
  LONG_MILESTONES,
  MILESTONES,
  PathTraceSession,
  REST_SAMPLES,
  environmentTexture,
  prepareEnvironment,
  shareUNets,
  historySignature,
  preparePathTraceScene,
  sceneParts,
  sceneSignature,
  thinGlass,
} from './pathtrace'
import { palette } from './palette'

const environment = { isTexture: true } as unknown as Texture

function fixture() {
  const scene = new Scene()
  const sky = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  sky.userData.pathTrace = false
  const helpers = new Group()
  helpers.userData.pathTrace = false
  const line = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  const sun = new DirectionalLight()
  sun.userData.pathTrace = false
  const leaf = new MeshStandardNodeMaterial()
  leaf.userData.pathTrace = { color: new Color('#5f7a3c'), roughness: 0.7 }
  const foliage = new Mesh(new BoxGeometry(), leaf)
  const glass = new MeshPhysicalNodeMaterial()
  glass.transmission = 1
  glass.thickness = 0.03
  glass.attenuationColor = new Color(0.5, 0.8, 0.6)
  glass.attenuationDistance = 0.3
  const pane = new Mesh(new BoxGeometry(), glass)
  const stone = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial())
  scene.add(sky, helpers, line, sun, foliage, pane, stone)
  return { scene, sky, helpers, line, sun, leaf, foliage, glass, pane, stone }
}

describe("the local tracer's targets", () => {
  it("rests at 256 denoised samples, the spin's good tier, and carries an export on to 384", () => {
    expect(REST_SAMPLES).toBe(256)
    expect(EXPORT_SAMPLES).toBe(384)
    expect(EXPORT_SAMPLES).toBeGreaterThan(REST_SAMPLES)
    // The milestones double up to the resting target and stop there: an export's image is
    // denoised once accumulation stops at its target, not at a milestone past the rest.
    expect(MILESTONES).toEqual([8, 16, 32, 64, 128, 256])
    expect(MILESTONES[MILESTONES.length - 1]).toBe(REST_SAMPLES)
    for (let i = 1; i < MILESTONES.length; i++) expect(MILESTONES[i]).toBe(2 * MILESTONES[i - 1])
  })

  it('keeps doubling past the rest for longer live targets, never inside an export', () => {
    expect(LONG_MILESTONES).toEqual([512, 1024])
    expect(LONG_MILESTONES[0]).toBe(2 * REST_SAMPLES)
    // No milestone lies between the resting target and an export's: the export denoises once.
    expect(LONG_MILESTONES.every((m) => m > EXPORT_SAMPLES)).toBe(true)
  })
})

describe('path-traced scene capture', () => {
  it('swaps in tracer-readable stand-ins and restores the raster scene exactly', () => {
    const f = fixture()
    const lineMaterial = f.line.material
    const leafColor = f.leaf.color.clone()
    const look = skyLook('backyard', 13)
    const restore = preparePathTraceScene(f.scene, look, environment)

    // Excluded objects and meshes the tracer cannot shade are hidden, with plain materials.
    expect(f.sky.visible).toBe(false)
    expect(f.helpers.visible).toBe(false)
    expect(f.sun.visible).toBe(false)
    expect(f.line.visible).toBe(false)
    expect(f.line.material).not.toBe(lineMaterial)
    expect(f.stone.visible).toBe(true)
    // Material overrides and thin-walled glass.
    expect(f.leaf.color.getHexString()).toBe('5f7a3c')
    expect(f.leaf.roughness).toBe(0.7)
    expect(f.glass.thickness).toBe(0)
    expect(f.glass.attenuationDistance).toBe(Infinity)
    // The sun is a disc light at its true angular size, carrying the full irradiance.
    const disc = f.scene.children.find((c) => (c as RectAreaLight).isRectAreaLight) as RectAreaLight
    expect(disc).toBeDefined()
    const distance = disc.position.length()
    const solidAngle = (Math.PI * (disc.width / 2) ** 2) / distance ** 2
    expect(disc.intensity * solidAngle).toBeCloseTo(4.2 * look.sunlight.intensity, 6)
    expect(Math.atan(disc.width / 2 / distance) * (180 / Math.PI)).toBeCloseTo(0.2665, 4)
    expect(f.scene.environment).toBe(environment)
    expect(f.scene.background).toBe(environment)

    restore()
    expect(f.sky.visible && f.helpers.visible && f.sun.visible && f.line.visible).toBe(true)
    expect(f.line.material).toBe(lineMaterial)
    expect(f.leaf.color.equals(leafColor)).toBe(true)
    expect(f.glass.thickness).toBe(0.03)
    expect(f.glass.attenuationDistance).toBe(0.3)
    expect(f.scene.children.some((c) => (c as RectAreaLight).isRectAreaLight)).toBe(false)
    expect(f.scene.environment).toBe(null)
    expect(f.scene.background).toBe(null)
  })

  it('adds no sun after dark or in the photo studio', () => {
    for (const look of [skyLook('backyard', 21.5), skyLook('studio', 13)]) {
      const f = fixture()
      const restore = preparePathTraceScene(f.scene, look, environment)
      expect(f.scene.children.some((c) => (c as RectAreaLight).isRectAreaLight)).toBe(false)
      restore()
    }
  })

  it('tints thin glass by what the pane would absorb', () => {
    const glass = new MeshPhysicalNodeMaterial()
    glass.transmission = 1
    glass.thickness = 0.1
    glass.attenuationColor = new Color(0.25, 1, 1)
    glass.attenuationDistance = 0.2
    const thin = thinGlass(glass as never)!
    expect(thin.color.r).toBeCloseTo(0.5, 6) // 0.25 ^ (0.1 / 0.2)
    expect(thin.color.g).toBeCloseTo(1, 6)
    expect(thinGlass(new MeshPhysicalNodeMaterial() as never)).toBe(null)
  })

  it('traces the clear glazing as a pane, not as its black raster albedo', () => {
    // The raster pane is a black, transparent reflection blended over the room; the tracers get a
    // clear thin pane instead, and the raster material comes back untouched.
    const glass = palette.glass() as MeshPhysicalNodeMaterial
    const scene = new Scene()
    scene.add(new Mesh(new BoxGeometry(), glass))
    const restore = preparePathTraceScene(scene, skyLook('courtyard', 12), environment)
    expect(glass.transmission).toBe(1)
    expect(glass.thickness).toBe(0)
    expect(glass.attenuationDistance).toBe(Infinity)
    expect(glass.color.getHex()).toBe(0xffffff)
    expect(glass.transparent).toBe(false)
    restore()
    expect(glass.transmission).toBe(0)
    expect(glass.transparent).toBe(true)
    expect(glass.color.getHex()).toBe(0x000000)
    expect(glass.userData.glass).toBe(true)
  })

  it('fingerprints exactly what the tracer captures', () => {
    const f = fixture()
    const base = sceneSignature(f.scene, 'a')
    f.scene.updateMatrixWorld(true)
    expect(sceneSignature(f.scene, 'a')).toBe(sceneSignature(f.scene, 'a'))
    expect(sceneSignature(f.scene, 'b')).not.toBe(sceneSignature(f.scene, 'a'))
    const settled = sceneSignature(f.scene, 'a')
    f.stone.position.x = 2
    f.scene.updateMatrixWorld(true)
    expect(sceneSignature(f.scene, 'a')).not.toBe(settled)
    const moved = sceneSignature(f.scene, 'a')
    f.leaf.needsUpdate = true
    expect(sceneSignature(f.scene, 'a')).not.toBe(moved)
    const updated = sceneSignature(f.scene, 'a')
    f.foliage.visible = false
    expect(sceneSignature(f.scene, 'a')).not.toBe(updated)
    expect(base).toBeTypeOf('number')
  })

  it('tells apart edits that need a new capture from those updated in place', () => {
    const f = fixture()
    f.scene.updateMatrixWorld(true)
    const changed = (edit: () => void) => {
      const before = sceneParts(f.scene)
      edit()
      f.scene.updateMatrixWorld(true)
      const after = sceneParts(f.scene)
      return (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k])
    }
    // Moving a mesh refits the BVH; a new finish or light level updates buffers in place.
    expect(changed(() => (f.stone.position.y = 3))).toEqual(['transforms'])
    expect(changed(() => (f.leaf.needsUpdate = true))).toEqual(['materials'])
    expect(changed(() => (f.stone.material = new MeshStandardNodeMaterial()))).toEqual([
      'materials',
    ])
    expect(changed(() => (f.sun.intensity = 0.5))).toEqual(['lights'])
    // Meshes appearing or disappearing need the BVH built again.
    expect(changed(() => (f.foliage.visible = false))).toContain('structure')
    expect(changed(() => f.scene.add(new Mesh(new BoxGeometry(), f.leaf)))).toContain('structure')
  })

  it('invalidates both views for edits visible through glazing, but ignores helpers', () => {
    const f = fixture()
    const room = new Group()
    room.userData.interior = true
    const bench = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial())
    const lamp = new RectAreaLight(0xffffff, 10, 1, 1)
    room.add(bench, lamp)
    f.scene.add(room)
    f.scene.updateMatrixWorld(true)
    const outside = () => sceneSignature(f.scene, 'a', 'exterior')
    const inside = () => sceneSignature(f.scene, 'a', 'interior')
    const [out0, in0] = [outside(), inside()]
    expect(out0).toBe(in0)
    bench.position.x = 2
    f.scene.updateMatrixWorld(true)
    expect(outside()).not.toBe(out0)
    expect(inside()).not.toBe(in0)
    const in1 = inside()
    lamp.intensity = 4
    expect(outside()).not.toBe(in1)
    expect(inside()).not.toBe(in1)
    const in2 = inside()
    f.stone.position.y = 3
    f.scene.updateMatrixWorld(true)
    expect(inside()).not.toBe(in2)
    expect(outside()).not.toBe(out0)
    const out1 = outside()
    const in3 = inside()
    // The dimensions helpers (pathTrace: false) come and go without a frame changing.
    const dimensions = new Group()
    dimensions.userData.pathTrace = false
    dimensions.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()))
    f.scene.add(dimensions)
    f.scene.updateMatrixWorld(true)
    expect(outside()).toBe(out1)
    expect(inside()).toBe(in3)
    f.helpers.visible = false
    expect(outside()).toBe(out1)
    expect(inside()).toBe(in3)
    // The whole scene's fingerprint, the local tracer's, still sees the room.
    expect(sceneSignature(f.scene, 'a')).not.toBe(out1)
  })

  it('fingerprints the shell and its glazing, seen from both sides, into both parts', () => {
    const f = fixture()
    const room = new Group()
    room.userData.interior = true
    room.add(new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial()))
    const shell = new Group()
    shell.userData.shared = true
    const door = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial())
    shell.add(door)
    f.scene.add(room, shell)
    f.scene.updateMatrixWorld(true)
    const outside = () => sceneSignature(f.scene, 'a', 'exterior')
    const inside = () => sceneSignature(f.scene, 'a', 'interior')
    const [out0, in0] = [outside(), inside()]
    // The door swings open: the panorama looks straight at it, and so does the ring.
    door.rotation.y = 1.2
    f.scene.updateMatrixWorld(true)
    expect(outside()).not.toBe(out0)
    expect(inside()).not.toBe(in0)
    const [out1, in1] = [outside(), inside()]
    // A new door leaf (rebuilt parts have new ids), likewise.
    shell.remove(door)
    shell.add(new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial()))
    f.scene.updateMatrixWorld(true)
    expect(outside()).not.toBe(out1)
    expect(inside()).not.toBe(in1)
    // The exterior is also visible from inside.
    const [out2, in2] = [outside(), inside()]
    f.stone.position.y = 3
    f.scene.updateMatrixWorld(true)
    expect(outside()).not.toBe(out2)
    expect(inside()).not.toBe(in2)
  })

  it('includes the shell finish and lights in interior reflections', () => {
    const f = fixture()
    const room = new Group()
    room.userData.interior = true
    room.add(new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial()))
    const shell = new Group()
    shell.userData.shared = true
    const leaf = () => {
      const geometry = new BoxGeometry()
      geometry.userData.key = 'door-leaf'
      return geometry
    }
    let door = new Mesh(leaf(), new MeshStandardNodeMaterial())
    const lamp = new RectAreaLight(0xffffff, 10, 1, 1)
    shell.add(door, lamp)
    f.scene.add(room, shell)
    f.scene.updateMatrixWorld(true)
    const outside = () => sceneSignature(f.scene, 'a', 'exterior')
    const inside = () => sceneSignature(f.scene, 'a', 'interior')
    const [out0, in0] = [outside(), inside()]
    // A new finish: the shell is rebuilt (new meshes, a new material) to the same shape, as
    // StudioModel rebuilds it for the stills (the live 360° view keeps the meshes and swaps their
    // material, which changes the fingerprints just as well). Both views must refresh.
    shell.remove(door)
    door = new Mesh(leaf(), new MeshStandardNodeMaterial())
    shell.add(door)
    f.scene.updateMatrixWorld(true)
    expect(outside()).not.toBe(out0)
    expect(inside()).not.toBe(in0)
    const out1 = outside()
    door.material.needsUpdate = true
    expect(outside()).not.toBe(out1)
    expect(inside()).not.toBe(out1)
    const out2 = outside()
    lamp.intensity = 4
    expect(outside()).not.toBe(out2)
    expect(inside()).not.toBe(out2)
    // The door hidden, moved, or of another shape: both.
    const out3 = outside()
    door.visible = false
    expect(outside()).not.toBe(out3)
    expect(inside()).not.toBe(in0)
    door.visible = true
    const [out4, in4] = [outside(), inside()]
    door.position.x = 1
    f.scene.updateMatrixWorld(true)
    expect(outside()).not.toBe(out4)
    expect(inside()).not.toBe(in4)
    const [out5, in5] = [outside(), inside()]
    door.geometry.userData.key = 'door-leaf-wide'
    expect(outside()).not.toBe(out5)
    expect(inside()).not.toBe(in5)
  })

  it('reads a rebuilt mesh of a keyed geometry as the same shape, in whatever order', () => {
    const f = fixture()
    const room = new Group()
    room.userData.interior = true
    const shelf = () => {
      const geometry = new BoxGeometry()
      geometry.userData.key = 'shelf'
      return geometry
    }
    const material = new MeshStandardNodeMaterial()
    const first = new Mesh(shelf(), material)
    const bench = new Mesh(new BoxGeometry(), material)
    room.add(first, bench)
    f.scene.add(room)
    f.scene.updateMatrixWorld(true)
    const before = sceneParts(f.scene, 'interior')
    const whole = sceneParts(f.scene)
    // Rebuilt, and mounted after the bench this time.
    room.remove(first)
    room.add(new Mesh(shelf(), material))
    f.scene.updateMatrixWorld(true)
    expect(sceneParts(f.scene, 'interior')).toEqual(before)
    // The whole scene is the local tracer's, which holds the meshes it captured: new ones are a
    // new structure to it.
    expect(sceneParts(f.scene).structure).not.toBe(whole.structure)
    // Without a key, a geometry is told apart by its id, as a mesh of another shape must be.
    room.add(new Mesh(new BoxGeometry(), material))
    expect(sceneParts(f.scene, 'interior').structure).not.toBe(before.structure)
  })

  it('leaves the materials as the raster renderer knows them after a capture', () => {
    // A pane's transmission is turned on for the tracer and off again after; the physical
    // material counts each as a change of shader. Nothing changed for the rasterizer, and the
    // fingerprints must not find a new design after every capture.
    const f = fixture()
    const glass = palette.glass()
    f.scene.add(new Mesh(new BoxGeometry(), glass))
    f.scene.updateMatrixWorld(true)
    const versions = [glass.version, f.glass.version, f.leaf.version]
    const before = sceneSignature(f.scene, 'a')
    preparePathTraceScene(f.scene, skyLook('backyard', 13), environment)()
    expect([glass.version, f.glass.version, f.leaf.version]).toEqual(versions)
    expect(sceneSignature(f.scene, 'a')).toBe(before)
  })

  it('notices a move along any axis, alone or combined', () => {
    const f = fixture()
    f.scene.updateMatrixWorld(true)
    const moves: [number, number, number][] = [
      [4.25, 0, -2.75], // a floor-plan drag that a weighted sum of x and z cancels
      [0.25, 0, 0],
      [0, 0.25, 0],
      [0, 0, 0.25],
    ]
    for (const move of moves) {
      const before = sceneSignature(f.scene, 'a')
      f.stone.position.x += move[0]
      f.stone.position.y += move[1]
      f.stone.position.z += move[2]
      f.scene.updateMatrixWorld(true)
      expect(sceneSignature(f.scene, 'a')).not.toBe(before)
    }
  })
})

describe("the history's key of a scene", () => {
  /** The fixture's scene with a keyed shelf, a lamp and an emitter, as the unit's lists are. */
  function room() {
    const f = fixture()
    const shelf = () => {
      const geometry = new BoxGeometry()
      geometry.userData.key = 'shelf'
      return geometry
    }
    let mesh = new Mesh(shelf(), new MeshStandardNodeMaterial())
    const lamp = new RectAreaLight(0xffffff, 10, 1, 1)
    const glow = new MeshStandardNodeMaterial()
    glow.emissive = new Color('#ffeedd')
    glow.emissiveIntensity = 2
    f.scene.add(mesh, lamp, new Mesh(new BoxGeometry(), glow))
    f.scene.updateMatrixWorld(true)
    /** The shelf rebuilt to the same shape in another finish, as the stills rebuild it. */
    const repaint = () => {
      f.scene.remove(mesh)
      mesh = new Mesh(shelf(), new MeshStandardNodeMaterial({ color: '#884422' }))
      f.scene.add(mesh)
      f.scene.updateMatrixWorld(true)
    }
    return {
      ...f,
      lamp,
      glow,
      repaint,
      shelf: () => mesh,
      key: () => historySignature(f.scene, 'a'),
    }
  }

  it('holds through a finish, a colour, or a rebuilt mesh, where the full fingerprint does not', () => {
    const r = room()
    const [key, whole, full] = [r.key(), sceneParts(r.scene), sceneSignature(r.scene, 'a')]
    r.repaint()
    expect(r.key()).toBe(key)
    expect(sceneParts(r.scene).structure).not.toBe(whole.structure)
    expect(sceneSignature(r.scene, 'a')).not.toBe(full)
    // In place: a new colour, a material rebuilt by a probe.
    ;(r.shelf().material as MeshStandardNodeMaterial).color.set('#224488')
    r.leaf.needsUpdate = true
    expect(r.key()).toBe(key)
    // Helpers no tracer sees come and go.
    const helper = new Group()
    helper.userData.pathTrace = false
    helper.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()))
    r.scene.add(helper)
    r.scene.updateMatrixWorld(true)
    expect(r.key()).toBe(key)
  })

  it('changes with what moves light elsewhere: shapes, places, lights, sky, emitters, glass', () => {
    const r = room()
    expect(historySignature(r.scene, 'b')).not.toBe(r.key())
    // A raster glazing pane traces as glass through its stand-in.
    const glazing = new Mesh(new BoxGeometry(), palette.glass())
    r.scene.add(glazing)
    const edits: [string, () => void][] = [
      ['shape', () => (r.shelf().geometry.userData.key = 'shelf-wide')],
      ['hidden', () => (r.stone.visible = false)],
      ['moved', () => r.shelf().position.set(0, 1, 0)],
      ['light', () => (r.lamp.intensity = 4)],
      ['emitter', () => (r.glow.emissiveIntensity = 0.5)],
      ['emitter colour', () => r.glow.emissive.set('#ff0000')],
      ['glass', () => (r.pane.material = new MeshPhysicalNodeMaterial({ transmission: 1 }))],
      ['glazing', () => (glazing.material = palette.glass().clone())],
    ]
    r.scene.updateMatrixWorld(true)
    let key = r.key()
    for (const [name, edit] of edits) {
      edit()
      r.scene.updateMatrixWorld(true)
      expect(r.key(), name).not.toBe(key)
      key = r.key()
    }
  })
})

describe('a tracing session (tracer and GPU mocked, not a GPU test)', () => {
  afterEach(() => vi.restoreAllMocks())
  const look = skyLook('studio', 13)

  /** Denoisers that finish when told to, each with its own image. */
  const denoisers: {
    complete: boolean
    texture: Texture | null
    denoise: ReturnType<typeof vi.fn>
    options: { initUNetFromURL: unknown }
  }[] = []
  function session(
    options: ConstructorParameters<typeof PathTraceSession>[3] = {},
    denoise = false,
  ) {
    denoisers.length = 0
    const unet = vi.fn(async () => ({ dispose: vi.fn() }))
    vi.spyOn(GBuffer.prototype, 'render').mockImplementation(() => {})
    const tracer = {
      setScene: vi.fn(),
      updateMaterials: vi.fn(),
      updateTransforms: vi.fn(),
      updateLights: vi.fn(),
      updateEnvironment: vi.fn(),
      updateCamera: vi.fn(),
      reset: vi.fn(),
      setSize: vi.fn(),
      renderSample: vi.fn(),
      setRandom: vi.fn(),
      dispose: vi.fn(),
      getSampleCountsAsync: () => Promise.resolve({ min: 0 }),
      renderScale: 1,
      fadeState: 1,
      target: { image: { width: 64, height: 32 } },
      material: { turquinTexture: { image: { width: 1, height: 1, depth: 1 } } },
      textureAtlas: { textureInfo: [{}, {}, {}] as unknown[] },
      _pathTracer: {
        setSize: vi.fn(),
        outputTarget: new StorageTexture(64, 32),
        sampleCountTarget: new StorageTexture(64, 32),
      },
    }
    const renderer = {
      initTexture: vi.fn(),
      backend: {
        get: () => ({}),
        device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } },
      },
      getDrawingBufferSize: (size: Vector2) => size.set(64, 32),
      getRenderTarget: () => null,
      setRenderTarget: vi.fn(),
      compute: vi.fn(),
      copyTextureToTexture: vi.fn(),
    }
    const modules = {
      tracer: {
        WebGPUPathTracer: class {
          constructor() {
            return tracer
          }
        },
        TRANSMISSIVE_BACKGROUND_ENVIRONMENT: 0,
        RANDOM_SOBOL: 'sobol-strategy',
        OIDNDenoiser: class {
          complete = false
          texture: Texture | null = null
          init = vi.fn()
          reset = vi.fn(() => {
            this.complete = false
          })
          denoise = vi.fn(() => Promise.resolve())
          constructor(readonly options: { initUNetFromURL: unknown }) {
            denoisers.push(this)
          }
        },
      },
      initUNetFromURL: denoise ? unet : null,
    }
    const traced = new PathTraceSession(renderer as never, modules as never, denoise, options)
    const f = fixture()
    const camera = new PerspectiveCamera()
    f.scene.updateMatrixWorld(true)
    const begin = () => traced.begin(f.scene, camera, look, 1024)
    /** Starts the view and traces a sample of it, once the previous batch is done. */
    const trace = async () => {
      begin()
      traced.step()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { traced, tracer, begin, trace, unet, ...f }
  }

  it('reports a view started once a batch of it has finished on the GPU, from each start', async () => {
    const t = session({ multiView: true })
    const queue = (
      t.traced as unknown as {
        renderer: { backend: { device: { queue: { onSubmittedWorkDone: () => Promise<void> } } } }
      }
    ).renderer.backend.device.queue
    let finish!: () => void
    queue.onSubmittedWorkDone = () => new Promise<void>((resolve) => (finish = resolve))
    t.begin()
    expect(t.traced.started).toBe(false)
    t.traced.step()
    expect(t.traced.started).toBe(false)
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.traced.started).toBe(true)
    // A new start waits for its own first batch.
    t.traced.halt()
    t.begin()
    expect(t.traced.started).toBe(false)
  })

  it('loads the shared denoiser network ahead of the first image, and never rejects', async () => {
    const t = session({ multiView: true }, true)
    const load = vi.fn(() => Promise.resolve('network'))
    ;(denoisers[0] as unknown as { _initUNet: typeof load })._initUNet = load
    await expect(t.traced.prepareDenoiser()).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledWith(true)
    load.mockImplementationOnce(() => Promise.reject(new Error('offline')))
    await expect(t.traced.prepareDenoiser()).resolves.toBeUndefined()
    // The tracer's own loader is still the one this calls (OIDNDenoiser.js).
    expect(
      readFileSync('node_modules/three-gpu-pathtracer/src/webgpu/denoise/OIDNDenoiser.js', 'utf8'),
    ).toContain('_initUNet( aux ) {')
  })

  it('frees a stopped view’s history, denoisers, snapshot and guides, keeping its capture', async () => {
    const t = session({ multiView: true, keepHistoryAcrossSurfaces: true }, true)
    const clear = vi.spyOn(MultiViewHistory.prototype, 'clear')
    const guides = vi.spyOn(GBuffer.prototype, 'dispose')
    await t.trace()
    // (The first start clears what was kept of another scene.)
    clear.mockClear()
    const disposed = denoisers.map((d) => {
      const spy = vi.fn()
      ;(d as unknown as { dispose: () => void }).dispose = spy
      return spy
    })
    // Never while tracing.
    t.traced.trim()
    expect(clear).not.toHaveBeenCalled()
    t.traced.halt()
    clear.mockClear()
    t.traced.trim()
    expect(clear).toHaveBeenCalledOnce()
    expect(guides).toHaveBeenCalledOnce()
    for (const spy of disposed) expect(spy).toHaveBeenCalledOnce()
    // The capture stays: the next start updates the camera, building nothing again.
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    expect(t.traced.seeded).toBe(false)
  })

  it('gives both denoisers one network: loaded once, for both', async () => {
    const t = session({}, true)
    expect(denoisers).toHaveLength(2)
    type Load = (url: string, device: unknown, options: object) => Promise<unknown>
    const [a, b] = (denoisers as unknown as { options: { initUNetFromURL: Load } }[]).map(
      (d) => d.options.initUNetFromURL,
    )
    // As each OIDNDenoiser asks for its network on its first denoise.
    await Promise.all([a('weights', {}, { aux: true }), b('weights', {}, { aux: true })])
    expect(t.unet).toHaveBeenCalledOnce()
  })

  it("gives the stills' session (the legacy route's) the tracer settings it always had", () => {
    // RenderEffects makes its session with no options and starts views without a scale.
    const effects = readFileSync('src/components/RenderEffects.tsx', 'utf8')
    expect(effects).toContain('new PathTraceSession(renderer, module, denoise)')
    expect(effects).toContain('usable.begin(scene, camera, lookRef.current, target)')
    const t = session()
    expect(t.tracer).toMatchObject({
      maxBounces: 6,
      maxTransparentBounces: 12,
      filterGlossyFactor: 0.5,
      clampDirect: 0,
      clampIndirect: 10,
      renderScale: 1,
    })
    // Its clamps are the tracer's own defaults, which its setters skip as unchanged.
    const tracer = readFileSync(
      'node_modules/three-gpu-pathtracer/src/webgpu/WebGPUPathTracer.js',
      'utf8',
    )
    expect(tracer).toContain('this._clampDirect = 0;')
    expect(tracer).toContain('this._clampIndirect = 10;')
  })

  it('draws Sobol numbers scrambled per pixel only where asked (the 360° view)', () => {
    const sobol = session({ random: 'sobol' })
    expect(sobol.tracer.setRandom).toHaveBeenCalledWith('sobol-strategy')
    const stills = session()
    expect(stills.tracer.setRandom).not.toHaveBeenCalled()
  })

  it("passes the 360° view's depth and clamps to the tracer", () => {
    const t = session({ maxBounces: 7, clampDirect: 2, clampIndirect: 3 })
    expect(t.tracer).toMatchObject({ maxBounces: 7, clampDirect: 2, clampIndirect: 3 })
  })

  it('traces at the scale a start names, sized before the seed so the tracer never resizes', () => {
    const t = session()
    const guides = vi.mocked(GBuffer.prototype.render)
    // What the tracer held when it was sized: the scale must already be the new one.
    const scaleAtSize: number[] = []
    t.tracer.setSize.mockImplementation(() => scaleAtSize.push(t.tracer.renderScale))
    t.traced.begin(t.scene, new PerspectiveCamera(), look, 1024, 0.75)
    expect(t.tracer.renderScale).toBe(0.75)
    expect(scaleAtSize).toEqual([0.75])
    // The 64×32 drawing buffer at 0.75, floored as the tracer's renderSample sizes itself.
    expect(t.tracer.setSize).toHaveBeenLastCalledWith(48, 24)
    expect(t.tracer._pathTracer.setSize).toHaveBeenLastCalledWith(48, 24)
    // The denoiser's guides follow the trace's resolution.
    expect(guides.mock.lastCall!.slice(3)).toEqual([48, 24])
    // A start that names none (the stills, the legacy route) keeps the scale the tracer has.
    t.traced.begin(t.scene, new PerspectiveCamera(), look, 1024)
    expect(t.tracer.renderScale).toBe(0.75)
    expect(t.tracer.setSize).toHaveBeenLastCalledWith(48, 24)
  })

  it('sizes from the scale as the installed tracer does, so its first sample never resets the seed', () => {
    // WebGPUPathTracer.renderSample re-derives its size from renderScale on every sample and
    // resets on any change; syncSize must agree with it exactly.
    const source = readFileSync(
      'node_modules/three-gpu-pathtracer/src/webgpu/WebGPUPathTracer.js',
      'utf8',
    )
    expect(source).toContain('const w = Math.floor( renderScale * _resolution.x );')
    expect(source).toContain('const h = Math.floor( renderScale * _resolution.y );')
    const t = session()
    t.traced.begin(t.scene, new PerspectiveCamera(), look, 1024)
    expect(t.tracer.renderScale).toBe(1)
    expect(t.tracer.setSize).toHaveBeenLastCalledWith(64, 32)
  })

  it('reads the materials again for scans that arrived, keeping the captured meshes', () => {
    const t = session()
    t.begin()
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    expect(t.tracer.updateMaterials).not.toHaveBeenCalled()
    t.traced.texturesChanged()
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    expect(t.tracer.updateMaterials).toHaveBeenCalledOnce()
    expect(t.tracer.updateTransforms).not.toHaveBeenCalled()
    expect(t.tracer.updateLights).not.toHaveBeenCalled()
    // Read once: the next start has nothing new.
    t.begin()
    expect(t.tracer.updateMaterials).toHaveBeenCalledOnce()
    // A finish swapped on the meshes it has (the live view keeps them) is updated in place too.
    t.stone.material = new MeshStandardNodeMaterial()
    t.begin()
    expect(t.tracer.updateMaterials).toHaveBeenCalledTimes(2)
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    // A re-capture asked for is one.
    t.traced.invalidate()
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledTimes(2)
  })

  it('compiles new kernels when an in-place update packs more textures than they index', () => {
    const t = session()
    const info = t.tracer.textureAtlas.textureInfo
    // As the tracer's updateMaterials does: the atlas's entries rebuilt for the textures in use.
    let textures = 3
    t.tracer.updateMaterials.mockImplementation(() => {
      info.length = 0
      for (let i = 0; i < textures; i++) info.push({})
    })
    const edit = () => {
      t.stone.material = new MeshStandardNodeMaterial()
      t.begin()
    }
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    // A floor swapped in on the meshes it has, while the old floor's scans stay in use elsewhere:
    // the atlas grows past the textureInfo array the kernels were compiled with.
    textures = 4
    edit()
    expect(t.tracer.updateMaterials).toHaveBeenCalledOnce()
    expect(t.tracer.setScene).toHaveBeenCalledTimes(2)
    // Back to fewer: updated in place, and the entries kept at the four the kernels were built
    // for, so a kernel the tracer rebuilds on its own (a resize) still holds four.
    textures = 3
    edit()
    expect(t.tracer.setScene).toHaveBeenCalledTimes(2)
    expect(info).toHaveLength(4)
    // So the four come back in place too, and only a fifth needs new kernels.
    textures = 4
    edit()
    expect(t.tracer.setScene).toHaveBeenCalledTimes(2)
    textures = 5
    t.traced.texturesChanged()
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledTimes(3)
  })

  it('still captures the scene again when it changed shape meanwhile', () => {
    const t = session()
    t.begin()
    t.traced.texturesChanged()
    t.scene.add(new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial()))
    t.scene.updateMatrixWorld(true)
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledTimes(2)
    expect(t.tracer.updateMaterials).not.toHaveBeenCalled()
  })

  it('keeps the orbit across surface edits where asked, seeding a little from it', async () => {
    const t = session({ multiView: true, keepHistoryAcrossSurfaces: true })
    const seed = vi.spyOn(ViewHistory.prototype, 'seed')
    const store = vi.spyOn(MultiViewHistory.prototype, 'store')
    const clear = vi.spyOn(MultiViewHistory.prototype, 'clear')
    const seededWith = () => seed.mock.lastCall![3] as HistoryKeys
    await t.trace()
    t.traced.halt()
    clear.mockClear()
    // The same view again: its full share.
    await t.trace()
    expect(t.traced.seeded).toBe(true)
    const before = seededWith()
    t.traced.halt()
    // A new finish on the same meshes: the same scene, other surfaces.
    t.stone.material = new MeshStandardNodeMaterial()
    await t.trace()
    expect(t.traced.seeded).toBe(true)
    expect(seededWith().scene).toBe(before.scene)
    expect(seededWith().surfaces).not.toBe(before.surfaces)
    // Scans arriving mid-trace: the view is kept under what it was traced of, not thrown away.
    const tracing = seededWith()
    t.traced.texturesChanged()
    t.traced.halt()
    expect(store.mock.lastCall![3]).toEqual(tracing)
    await t.trace()
    expect(t.traced.seeded).toBe(true)
    expect(seededWith().surfaces).not.toBe(tracing.surfaces)
    t.traced.halt()
    expect(clear).not.toHaveBeenCalled()
    // A mesh moved: another scene, which nothing seeds.
    t.stone.position.x = 3
    t.scene.updateMatrixWorld(true)
    await t.trace()
    expect(clear).toHaveBeenCalled()
    expect(t.traced.seeded).toBe(false)
  })

  it('never seeds a still across a design or scans arriving, as it never has', async () => {
    const t = session()
    const store = vi.spyOn(ViewHistory.prototype, 'store')
    await t.trace()
    t.traced.halt()
    // One key: the full fingerprint, scans included.
    const stored = store.mock.lastCall![3] as HistoryKeys
    expect(stored.scene).toBe(stored.surfaces)
    await t.trace()
    expect(t.traced.seeded).toBe(true)
    t.traced.halt()
    // Another finish: another design.
    t.stone.material = new MeshStandardNodeMaterial()
    await t.trace()
    expect(t.traced.seeded).toBe(false)
    t.traced.halt()
    // Scans arriving, between views or during one: another texture set.
    t.traced.texturesChanged()
    await t.trace()
    expect(t.traced.seeded).toBe(false)
    t.traced.invalidate()
    t.traced.halt()
    await t.trace()
    expect(t.traced.seeded).toBe(false)
    t.traced.halt()
    // Nothing changed: the same still, seeded as before.
    await t.trace()
    expect(t.traced.seeded).toBe(true)
  })

  it('keeps a Cycles image as a view the first start seeds from, at the size it will trace', async () => {
    const t = session({ multiView: true, keepHistoryAcrossSurfaces: true })
    const kept = vi.spyOn(MultiViewHistory.prototype, 'storeImage').mockImplementation(() => {})
    const seed = vi.spyOn(MultiViewHistory.prototype, 'seed').mockReturnValue(true)
    const clear = vi.spyOn(MultiViewHistory.prototype, 'clear')
    const guides = vi.mocked(GBuffer.prototype.render)
    const lens = new PerspectiveCamera(50, 1.6)
    const image = { image: environment, table: environment, count: 16, ceiling: 0.94 }
    expect(t.traced.storeImage(t.scene, lens, look, image, 0.75)).toBe(true)
    // Rendered from the image's camera, at the 64×32 buffer at 0.75, as the start will be.
    expect(guides.mock.lastCall![2]).toBe(lens)
    expect(guides.mock.lastCall!.slice(3)).toEqual([48, 24])
    const [, given, , keys, width, height] = kept.mock.lastCall!
    expect(given).toBe(image)
    expect([width, height]).toEqual([48, 24])
    clear.mockClear()
    t.traced.begin(t.scene, new PerspectiveCamera(), look, 1024, 0.75)
    // The start keeps it (the same scene) and seeds from it, under the keys it was kept with.
    expect(clear).not.toHaveBeenCalled()
    expect(seed.mock.lastCall![3]).toEqual(keys)
    expect(t.traced.seeded).toBe(true)
    // Never while a view is tracing: that view's own samples are what the next one takes.
    expect(t.traced.storeImage(t.scene, lens, look, image, 0.75)).toBe(false)
    expect(kept).toHaveBeenCalledOnce()
  })

  describe('early refinement (mocked clock and denoiser)', () => {
    let now = 0
    let counts = 0
    const run = async (options: ConstructorParameters<typeof PathTraceSession>[3]) => {
      now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const t = session({ batchMs: 12, maxPasses: 8, fadeMs: 260, ...options }, true)
      t.tracer.getSampleCountsAsync = () => Promise.resolve({ min: counts })
      t.begin()
      /** A display frame `ms` on, with every pixel at `samples`. */
      const frame = async (samples: number, ms = 16) => {
        counts = samples
        now += ms
        t.traced.step()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      /** The running denoiser finishes, with an image of its own. */
      const finish = () => {
        const busy = denoisers.find((d) => d.denoise.mock.calls.length && !d.complete)!
        busy.complete = true
        busy.texture = new StorageTexture(1, 1)
        return busy
      }
      return { ...t, frame, finish }
    }

    it('denoises an unseeded live view from 2 samples on; the stills wait for 8', async () => {
      expect(EARLY_MILESTONES).toEqual([2, 4, ...MILESTONES, ...LONG_MILESTONES])
      const live = await run({ earlyImages: true })
      await live.frame(2)
      await live.frame(2)
      expect(denoisers.some((d) => d.denoise.mock.calls.length)).toBe(true)
      const still = await run({})
      await still.frame(2)
      await still.frame(2)
      await still.frame(4)
      expect(denoisers.some((d) => d.denoise.mock.calls.length)).toBe(false)
      for (let i = 0; i < 6; i++) await still.frame(8)
      expect(denoisers.some((d) => d.denoise.mock.calls.length)).toBe(true)
    })

    it('fades the first image in quickly and the later ones as before, marking each', async () => {
      const marks = vi.spyOn(performance, 'mark')
      const t = await run({ earlyImages: true, firstFadeMs: 120, timeline: true })
      await t.frame(2)
      await t.frame(2)
      t.finish()
      await t.frame(3)
      expect(t.traced.view(now + 60).t).toBeCloseTo(0.5)
      expect(t.traced.view(now + 60).from).toBeNull()
      // Past the first image, the count is read every sixth batch.
      await t.frame(4, 200)
      for (let i = 0; i < 6; i++) await t.frame(4)
      t.finish()
      await t.frame(5)
      expect(t.traced.view(now + 130).t).toBeCloseTo(0.5)
      const names = marks.mock.calls.map(([name]) => name)
      expect(names).toContain('fury:trace-first-image')
      expect(names).toContain('fury:trace-milestone-2')
      expect(names).toContain('fury:trace-milestone-4')
    })

    it('marks nothing where not asked (the stills)', async () => {
      const marks = vi.spyOn(performance, 'mark')
      const t = await run({ earlyImages: true })
      await t.frame(2)
      await t.frame(2)
      t.finish()
      await t.frame(3)
      expect(marks.mock.calls.map(([name]) => name)).not.toContain('fury:trace-first-image')
    })

    it('takes larger batches once a view has rested a second, and none without a rest budget', async () => {
      const rest = { afterMs: 1000, batchMs: 24, maxPasses: 16 }
      const t = await run({ restBatch: rest })
      const budget = (at: number) =>
        (t.traced as unknown as { budget: (now: number) => unknown }).budget(at)
      expect(budget(999)).toEqual({ batchMs: 12, maxPasses: 8 })
      expect(budget(1000)).toEqual(rest)
      // The next view starts small again.
      now = 5000
      t.begin()
      expect(budget(5500)).toEqual({ batchMs: 12, maxPasses: 8 })
      const plain = await run({})
      expect(
        (plain.traced as unknown as { budget: (now: number) => unknown }).budget(60000),
      ).toEqual({ batchMs: 12, maxPasses: 8 })
    })
  })
})

describe('the sky map built off the main thread', () => {
  afterEach(() => vi.unstubAllGlobals())
  const same = (a: Float32Array, b: Float32Array) =>
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
      Buffer.from(b.buffer, b.byteOffset, b.byteLength),
    )
  /** A worker that runs sky.worker.ts's arithmetic, or fails. */
  const worker = (fail = false) => {
    const posted: unknown[] = []
    class FakeWorker extends EventTarget {
      postMessage(message: {
        id: number
        look: ReturnType<typeof skyLook>
        width: number
        height: number
      }) {
        posted.push(message)
        queueMicrotask(() => {
          if (fail) return this.dispatchEvent(new Event('error'))
          const { id, look, width, height } = message
          const data = equirectRadiance(width, height, (d) => environmentRadiance(d, look))
          this.dispatchEvent(new MessageEvent('message', { data: { id, data } }))
        })
      }
    }
    vi.stubGlobal('Worker', FakeWorker)
    return posted
  }

  it('hands the tracer the map the worker built, the same one it would build itself', async () => {
    const posted = worker()
    const look = skyLook('campus', 9.25)
    await prepareEnvironment(look)
    expect(posted).toHaveLength(1)
    const own = equirectRadiance(1024, 512, (d) => environmentRadiance(d, look))
    expect(same((environmentTexture(look).image as { data: Float32Array }).data, own)).toBe(true)
    // Asked again: ready, no second build.
    await prepareEnvironment(look)
    expect(posted).toHaveLength(1)
  }, 30000)

  it('never rejects: where the worker fails, the map is built as before', async () => {
    worker(true)
    const look = skyLook('desert', 15.75)
    await expect(prepareEnvironment(look)).resolves.toBeUndefined()
    const own = equirectRadiance(1024, 512, (d) => environmentRadiance(d, look))
    expect(same((environmentTexture(look).image as { data: Float32Array }).data, own)).toBe(true)
  }, 30000)
})

describe('one denoiser network for both denoisers', () => {
  const network = () => ({
    id: Math.random(),
    dispose: vi.fn(),
    tileExecute: vi.fn(function (this: unknown) {
      return this
    }),
  })

  it('loads it once, binds its methods, and disposes it with its last user', async () => {
    const made: ReturnType<typeof network>[] = []
    const init = vi.fn(async () => {
      const n = network()
      made.push(n)
      return n
    })
    const load = shareUNets(init)
    const options = { aux: true, hdr: true }
    const [a, b] = await Promise.all([
      load('weights.tza', {}, options),
      load('weights.tza', {}, { ...options }),
    ])
    expect(init).toHaveBeenCalledOnce()
    // Its own methods run on the network itself.
    expect((a as unknown as ReturnType<typeof network>).tileExecute()).toBe(made[0])
    a.dispose()
    a.dispose()
    expect(made[0].dispose).not.toHaveBeenCalled()
    b.dispose()
    expect(made[0].dispose).toHaveBeenCalledOnce()
    // Disposed: the next user loads it again.
    await load('weights.tza', {}, options)
    expect(init).toHaveBeenCalledTimes(2)
    // Other weights or options are another network.
    await load('weights.tza', {}, { aux: false, hdr: true })
    expect(init).toHaveBeenCalledTimes(3)
  })

  it('tries a failed load again for the next user', async () => {
    const init = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => network())
    const load = shareUNets(init)
    await expect(load('w', {}, {})).rejects.toThrow('offline')
    await expect(load('w', {}, {})).resolves.toBeDefined()
    expect(init).toHaveBeenCalledTimes(2)
  })
})
