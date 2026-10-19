import { describe, expect, it } from 'vitest'
import { defaultDesign, parseDesign, projectDesignToConfig } from '../../domain/design'
import { CUSTOMER_CAMERA_REFS } from '../../domain/presentation'
import { interiorBounds } from '../envelope'
import { galleryCamera } from '../gallery'
import { resolveNativeCamera } from './privateScene'

describe('native room-overview camera', () => {
  it.each([
    ['studio', 20],
    ['studio', 40],
    ['container', 20],
    ['container', 40],
  ] as const)('looks down the room from an end corner for %s %s', (family, lengthFt) => {
    const base = defaultDesign({ family, lengthFt })
    for (const aspect of ['wide', 'tall'] as const) {
      const design = parseDesign({
        ...base,
        presentation: { ...base.presentation, aspect, cameraRef: 'entry-draft@1' },
      })
      const bounds = interiorBounds(projectDesignToConfig(design))
      const camera = resolveNativeCamera(design)
      expect(Math.abs(camera.position[0])).toBeGreaterThan(bounds.halfWidth * 0.9)
      expect(Math.abs(camera.position[0])).toBeLessThan(bounds.halfWidth)
      expect(camera.position[1]).toBeLessThan(bounds.ceiling)
      expect(camera.position[2]).toBeLessThan(bounds.front)
      expect(camera.target[0]).toBe(0)
      expect(camera.target[2]).toBeLessThan(0)
      expect(camera.fov).toBe(aspect === 'wide' ? 64 : 86)
    }
  })

  it('leaves the four exterior camera bindings unchanged', () => {
    const base = defaultDesign()
    for (const cameraRef of CUSTOMER_CAMERA_REFS.filter((ref) => ref !== 'entry-draft@1')) {
      const design = parseDesign({ ...base, presentation: { ...base.presentation, cameraRef } })
      const angle = cameraRef.replace('-draft@1', '') as
        'front-left' | 'front' | 'left' | 'rear-left'
      expect(resolveNativeCamera(design)).toMatchObject(
        galleryCamera(projectDesignToConfig(design), angle, design.presentation.aspect),
      )
    }
  })
})
