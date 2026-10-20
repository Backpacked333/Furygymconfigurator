import { describe, expect, it } from 'vitest'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three/webgpu'
import { shadowOnly, unseen } from './shadowOnly'

describe('drawing an object as its shadow alone', () => {
  it('draws every mesh with a material that writes nothing, and puts them back', () => {
    const unit = new Group()
    const shell = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
    const glass = new Mesh(new BoxGeometry(), [new MeshStandardMaterial()])
    const inner = new Group()
    inner.add(glass)
    unit.add(shell, inner)
    shell.castShadow = true
    const before = [shell.material, glass.material]
    const restore = shadowOnly(unit)
    expect(shell.material).toBe(unseen)
    expect(glass.material).toBe(unseen)
    // Still there for the shadow pass: visible, casting.
    expect(shell.visible && shell.castShadow).toBe(true)
    expect(unseen.colorWrite).toBe(false)
    expect(unseen.depthWrite).toBe(false)
    restore()
    expect([shell.material, glass.material]).toEqual(before)
  })
})
