import {
  BufferGeometry,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three/webgpu'
import { noise } from '../lib/visuals'
import { boxProjectUV, custom, cylinder, mergeGeometries } from './geometry'
import type { Part } from './parts'
import type { Quality } from './quality'
import { grassBlade, type treeShape } from './vegetation'

/** Shared landscape helpers: instancing density per tier and procedural plant/rock geometry. */

export const DENSITY: Record<Quality, number> = { ultra: 1, high: 0.65, lite: 0.25 }

/**
 * A set of `per` instances at a tier's density, plus `base`: how many to build (at full density,
 * for the stills) and how many the tier draws (instances.ts).
 */
export function thinned(per: number, quality: Quality, base = 0) {
  return {
    count: Math.round(per * DENSITY.ultra) + base,
    drawn: Math.round(per * DENSITY[quality]) + base,
  }
}

const _up = new Vector3(0, 1, 0)
export function limbParts(shape: ReturnType<typeof treeShape>, bark: Material): Part[] {
  return shape.limbs.map(({ from, to, r0, r1 }, i) => {
    const direction = to.clone().sub(from)
    const length = direction.length()
    const geometry = cylinder(r1, r0, length, i < 2 ? 18 : 10)
    const matrix = new Matrix4().compose(
      from.clone().add(to).multiplyScalar(0.5),
      new Quaternion().setFromUnitVectors(_up, direction.normalize()),
      new Vector3(1, 1, 1),
    )
    return { geometry, material: bark, matrix, shadow: true }
  })
}

export function agaveGeometry() {
  return custom('agave', () => {
    const leaves: BufferGeometry[] = []
    for (let i = 0; i < 18; i++) {
      const g = grassBlade(1.1 + noise(i, 31) * 0.5, 0.75, 0.13)
      g.rotateX(-0.25 - noise(i, 32) * 0.45)
      g.rotateY((i / 18) * Math.PI * 2 * 1.618)
      leaves.push(g.toNonIndexed())
    }
    const merged = mergeGeometries(leaves)
    merged.computeVertexNormals()
    return boxProjectUV(merged)
  })
}

export function boulderGeometry(seed: number) {
  return custom(`boulder:${seed}`, () => {
    const g = new IcosahedronGeometry(1, 3)
    const p = g.getAttribute('position')
    const v = new Vector3()
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i)
      const n =
        Math.sin(v.x * 3.1 + seed) * 0.08 +
        Math.sin(v.y * 4.7 + seed * 2) * 0.06 +
        Math.sin(v.z * 5.3 + seed * 3) * 0.05
      v.multiplyScalar(1 + n)
      v.y = Math.max(v.y, -0.35) * 0.62
      p.setXYZ(i, v.x, v.y, v.z)
    }
    g.computeVertexNormals()
    return boxProjectUV(g)
  })
}
