import { MeshStandardMaterial } from 'three'
import { describe, expect, it } from 'vitest'
import { box, cylinder } from './geometry'
import { batch, part } from './parts'

describe('batched geometry', () => {
  it('is named by its content, so a model rebuilt from the same parts reads as the same shape', () => {
    const paint = new MeshStandardMaterial()
    const build = (finish: MeshStandardMaterial, lift = 0) => [
      part(box(2, 1, 1), finish, [0, lift, 0]),
      part(cylinder(0.2, 0.2, 1), finish, [1, 0, 0], [0, 0, 1]),
      part(box(1, 1, 1), finish, [0, 0, 2], undefined, [1, 1, -1]),
    ]
    const first = batch(build(paint))
    const again = batch(build(paint))
    expect(first).toHaveLength(1)
    expect(first[0].geometry).not.toBe(again[0].geometry)
    expect(first[0].geometry.userData.key).toMatch(/^batch:[0-9a-f]+$/)
    expect(again[0].geometry.userData.key).toBe(first[0].geometry.userData.key)
    // Another finish on the same parts: the same shape.
    expect(batch(build(new MeshStandardMaterial()))[0].geometry.userData.key).toBe(
      first[0].geometry.userData.key,
    )
    // A part placed elsewhere, or another part: another shape.
    expect(batch(build(paint, 0.5))[0].geometry.userData.key).not.toBe(
      first[0].geometry.userData.key,
    )
    expect(batch(build(paint).slice(1))[0].geometry.userData.key).not.toBe(
      first[0].geometry.userData.key,
    )
    // The generators name their geometries too.
    expect(box(2, 1, 1).userData.key).toBe(box(2, 1, 1).userData.key)
    expect(box(2, 1, 1).userData.key).not.toBe(box(2, 1, 1.5).userData.key)
  })
})
