import {
  BoxGeometry,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from 'three/webgpu'
import { MeshBVH } from 'three-mesh-bvh'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { TRACER_BVH_OPTIONS, attachBVH, buildBVH, bvhRequest } from './bvhBuild'
import { MIN_TRIANGLES, POOL_SIZE, geometriesToWarm, warmBVHs } from './bvhWarmup'

/** A geometry well above MIN_TRIANGLES, indexed or not, with groups or not. */
const big = (indexed: boolean, groups = false) => {
  const sphere = new SphereGeometry(1, 96, 64)
  const geometry = indexed ? sphere : sphere.toNonIndexed()
  if (groups) {
    const count = geometry.getIndex()?.count ?? geometry.getAttribute('position').count
    geometry.clearGroups()
    geometry.addGroup(0, count / 2, 0)
    geometry.addGroup(count / 2, count / 2, 1)
  }
  return geometry
}

const bytes = (buffers: ArrayBuffer[]) => buffers.map((b) => Array.from(new Uint8Array(b)))

describe('building the tracer’s BVHs off the main thread', () => {
  it('builds with the tracer’s own options', () => {
    const tracer = readFileSync(
      'node_modules/three-gpu-pathtracer/src/webgpu/WebGPUPathTracer.js',
      'utf8',
    )
    expect(tracer).toContain(
      'child.geometry.boundsTree = new MeshBVH( child.geometry, { strategy: SAH, targetLeafSize: 5 } );',
    )
    expect(TRACER_BVH_OPTIONS).toMatchObject({ targetLeafSize: 5 })
    // and it skips any geometry that already has one
    expect(tracer).toContain('if ( ! child.geometry.boundsTree ) {')
  })

  for (const [name, indexed, groups] of [
    ['indexed', true, false],
    ['non-indexed', false, false],
    ['grouped', true, true],
  ] as const)
    it(`leaves a ${name} geometry exactly as the tracer’s own build would`, () => {
      const own = big(indexed, groups)
      const warmed = own.clone()
      const tracer = new MeshBVH(own, TRACER_BVH_OPTIONS)
      const request = bvhRequest(warmed)!
      // Copies: the geometry the raster draws from is untouched while it builds.
      expect(request.position).not.toBe(warmed.getAttribute('position').array)
      const bvh = attachBVH(warmed, buildBVH(request))
      expect(Array.from(warmed.getIndex()!.array)).toEqual(Array.from(own.getIndex()!.array))
      expect(bytes(MeshBVH.serialize(bvh).roots)).toEqual(bytes(MeshBVH.serialize(tracer).roots))
      expect(warmed.boundingBox).toEqual(own.boundingBox)
      expect((warmed as BufferGeometry & { boundsTree?: MeshBVH }).boundsTree).toBe(bvh)
    })

  it('warms the large geometries the tracer will see, largest first, once each', () => {
    const material = new MeshBasicMaterial()
    const root = new Group()
    const large = big(true)
    const larger = new SphereGeometry(1, 128, 96)
    const small = new BoxGeometry()
    root.add(new Mesh(large, material), new Mesh(large, material), new Mesh(larger, material))
    root.add(new Mesh(small, material))
    expect(small.getIndex()!.count / 3).toBeLessThan(MIN_TRIANGLES)
    expect(geometriesToWarm(root)).toEqual([larger, large])
  })

  it('attaches results, skipping geometries replaced or built meanwhile', async () => {
    const material = new MeshBasicMaterial()
    const kept = big(true)
    const replaced = big(true)
    const raced = big(false)
    const root = new Group()
    root.add(new Mesh(kept, material), new Mesh(replaced, material), new Mesh(raced, material))
    // While building: one geometry's arrays are replaced (an edit), another gets its BVH from
    // the tracer's own build (it started without waiting).
    const order = geometriesToWarm(root)
    const build = vi.fn(async (request: Parameters<typeof buildBVH>[0]) => {
      const result = buildBVH(request)
      const which = order[build.mock.calls.length - 1]
      if (which === replaced) replaced.setIndex(Array.from(replaced.getIndex()!.array))
      if (which === raced)
        (raced as unknown as { boundsTree?: unknown }).boundsTree = new MeshBVH(
          raced,
          TRACER_BVH_OPTIONS,
        )
      return result
    })
    expect(await warmBVHs(root, build)).toBe(1)
    expect((kept as BufferGeometry & { boundsTree?: unknown }).boundsTree).toBeInstanceOf(MeshBVH)
    expect((replaced as BufferGeometry & { boundsTree?: unknown }).boundsTree).toBeUndefined()
  })

  it('builds several side by side, largest first, never more than the pool at once', async () => {
    const material = new MeshBasicMaterial()
    const root = new Group()
    const sizes = [40, 96, 64, 128, 48]
    const geometries = sizes.map((segments) => new SphereGeometry(1, segments, segments))
    for (const geometry of geometries) root.add(new Mesh(geometry, material))
    let running = 0
    let most = 0
    const started: number[] = []
    const build = vi.fn(async (request: Parameters<typeof buildBVH>[0]) => {
      started.push(request.position.length)
      running++
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return buildBVH(request)
    })
    expect(await warmBVHs(root, build, 3)).toBe(geometries.length)
    expect(most).toBe(3)
    expect(started).toEqual([...started].sort((a, b) => b - a))
    expect(POOL_SIZE).toBeGreaterThanOrEqual(1)
    expect(POOL_SIZE).toBeLessThanOrEqual(4)
  })

  it('never rejects: a geometry that fails to build is left to the tracer', async () => {
    const root = new Group()
    root.add(new Mesh(big(true), new MeshBasicMaterial()))
    expect(await warmBVHs(root, () => Promise.reject(new Error('worker gone')))).toBe(0)
  })
})
