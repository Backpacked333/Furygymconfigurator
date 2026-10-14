import { Box3, Color, Mesh, MeshStandardMaterial, SRGBColorSpace, Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  createCheckerTexture,
  createNeutralStage,
  MATERIAL_ROLES,
  NEUTRAL_STAGE,
} from './neutralStage'

describe('isolated neutral material stage', () => {
  it('uses 18% linear gray, fixed camera/exposure and a real one-foot checker', () => {
    const stage = createNeutralStage()
    expect(stage.camera.position.toArray()).toEqual([10, 7, 14])
    expect(NEUTRAL_STAGE.exposure).toBe(1)
    const patch = stage.scene.getObjectByName('18% gray reference') as Mesh
    const gray = patch.material as MeshStandardMaterial
    expect(gray.color.toArray()).toEqual([0.18, 0.18, 0.18])
    expect(gray.color).not.toEqual(new Color('#2e2e2e'))
    const checks = stage.scene.getObjectByName('One-foot floor checker') as Mesh
    const uv = checks.geometry.getAttribute('uv')
    const map = (checks.material as MeshStandardMaterial).map!
    expect(Math.max(...Array.from({ length: uv.count }, (_, i) => uv.getX(i)))).toBe(4)
    expect(map.repeat.x * 2).toBe(1)
    expect(map.colorSpace).toBe(SRGBColorSpace)
    expect(
      new Box3().setFromObject(stage.scene.getObjectByName('Floor — top at y=0')!).max.y,
    ).toBeCloseTo(0)
    for (const name of ['Dielectric sphere', 'Metal sphere']) {
      const bounds = new Box3().setFromObject(stage.scene.getObjectByName(name)!)
      expect(bounds.min.y).toBeCloseTo(0)
      expect(bounds.getSize(new Vector3()).y).toBeCloseTo(1.7)
    }
    stage.dispose()
  })
  it('distinguishes sRGB color from normal/packed linear data and never auto-flips green', () => {
    expect(MATERIAL_ROLES.albedo.colorSpace).toBe('srgb')
    expect(MATERIAL_ROLES.normal.colorSpace).toBe('')
    expect(MATERIAL_ROLES.arm.channels).toEqual({ ao: 'R', roughness: 'G', metalness: 'B' })
    expect(MATERIAL_ROLES.normal.convention).toBe('OpenGL +Y')
    const checker = createCheckerTexture()
    expect(checker.image.width).toBe(2)
    expect(checker.image.height).toBe(2)
    checker.dispose()
  })
  it('disposes owned resources once and does not dispose borrowed production swatches', () => {
    const borrowed = new MeshStandardMaterial()
    const disposeBorrowed = vi.spyOn(borrowed, 'dispose')
    const stage = createNeutralStage('warm', [{ name: 'borrowed', material: borrowed }])
    const gray = stage.scene.getObjectByName('18% gray reference') as Mesh
    const disposeMaterial = vi.spyOn(gray.material as MeshStandardMaterial, 'dispose')
    const disposeGeometry = vi.spyOn(gray.geometry, 'dispose')
    expect(stage.scene.getObjectByName('Vertical comparison: borrowed')).toBeDefined()
    stage.dispose()
    stage.dispose()
    expect(disposeMaterial).toHaveBeenCalledTimes(1)
    expect(disposeGeometry).toHaveBeenCalledTimes(1)
    expect(disposeBorrowed).not.toHaveBeenCalled()
    expect(stage.scene.children).toHaveLength(0)
    borrowed.dispose()
  })
})
