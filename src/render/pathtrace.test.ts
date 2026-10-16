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
  Scene,
  type Texture,
} from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { skyLook } from '../lib/visuals'
import { preparePathTraceScene, sceneParts, sceneSignature, thinGlass } from './pathtrace'
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
