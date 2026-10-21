// @vitest-environment jsdom
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  RectAreaLight,
  PerspectiveCamera,
  Scene,
  StorageTexture,
  Vector2,
  type Texture,
} from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { skyLook } from '../lib/visuals'
import { GBuffer } from './history'
import {
  EXPORT_SAMPLES,
  MILESTONES,
  PathTraceSession,
  REST_SAMPLES,
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
    // StudioModel rebuilds it. Both views must refresh.
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

describe('textures added after the scene was captured (tracer and GPU mocked)', () => {
  afterEach(() => vi.restoreAllMocks())
  const look = skyLook('studio', 13)

  function session() {
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
      },
      initUNetFromURL: null,
    }
    const traced = new PathTraceSession(renderer as never, modules as never, false)
    const f = fixture()
    f.scene.updateMatrixWorld(true)
    const camera = new PerspectiveCamera()
    const begin = () => traced.begin(f.scene, camera, look)
    /** A new material on the stone: an in-place update whose atlas then holds `count` textures. */
    const restyle = (count: number) => {
      f.stone.material = new MeshStandardNodeMaterial()
      tracer.updateMaterials.mockImplementationOnce(() => {
        tracer.textureAtlas.textureInfo = Array.from({ length: count }, () => ({}))
      })
      traced.halt()
      begin()
    }
    return { tracer, begin, restyle }
  }

  it('compiles new kernels when an update packs more textures than they index', () => {
    const t = session()
    t.begin()
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    // Scans arriving: five textures where the kernels were built for three.
    t.restyle(5)
    expect(t.tracer.updateMaterials).toHaveBeenCalledOnce()
    expect(t.tracer.setScene).toHaveBeenCalledTimes(2)
  })

  it('keeps fewer textures at the count the kernels index, without compiling again', () => {
    const t = session()
    t.begin()
    t.restyle(2)
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    // Padded back to the three the kernels were built for.
    expect(t.tracer.textureAtlas.textureInfo).toHaveLength(3)
  })

  it('updates in place as before when the count is unchanged', () => {
    const t = session()
    t.begin()
    t.restyle(3)
    expect(t.tracer.updateMaterials).toHaveBeenCalledOnce()
    expect(t.tracer.setScene).toHaveBeenCalledOnce()
    expect(t.tracer.updateCamera).toHaveBeenCalled()
  })
})
