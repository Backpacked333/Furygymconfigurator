import { describe, expect, it } from 'vitest'
import { DirectionalLight, Group, PointLight, Scene, SpotLight } from 'three'
import { invalidateShadows, refreshShadows } from './shadows'

function scene() {
  const root = new Scene()
  const sun = new DirectionalLight()
  sun.castShadow = true
  const spot = new SpotLight()
  spot.castShadow = true
  const fill = new PointLight()
  const nested = new Group()
  nested.add(spot)
  root.add(sun, nested, fill)
  return { root, sun, spot, fill }
}

describe('on-change shadow maps', () => {
  it('leaves shadows alone until the scene changes', () => {
    const { root, sun } = scene()
    expect(refreshShadows(root)).toBe(false)
    expect(sun.shadow.autoUpdate).toBe(true)
  })

  it('redraws every shadow-casting light once per change, then stops', () => {
    const { root, sun, spot, fill } = scene()
    invalidateShadows(root)
    invalidateShadows(root)
    expect(refreshShadows(root)).toBe(true)
    for (const light of [sun, spot]) {
      expect(light.shadow.autoUpdate).toBe(false)
      expect(light.shadow.needsUpdate).toBe(true)
    }
    expect(fill.shadow.needsUpdate).toBe(false)
    sun.shadow.needsUpdate = false
    expect(refreshShadows(root)).toBe(false)
    expect(sun.shadow.needsUpdate).toBe(false)
  })

  it('tracks scenes independently', () => {
    const a = scene()
    const b = scene()
    invalidateShadows(a.root)
    expect(refreshShadows(b.root)).toBe(false)
    expect(refreshShadows(a.root)).toBe(true)
  })
})
