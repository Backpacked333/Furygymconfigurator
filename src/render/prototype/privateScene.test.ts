import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { defaultDesign, parseDesign, projectDesignToConfig } from '../../domain/design'
import { CUSTOMER_CAMERA_REFS } from '../../domain/presentation'
import { interiorBounds } from '../envelope'
import { ASPECT_RATIO, galleryCamera } from '../gallery'
import { openingGeometry, productHeight } from '../../lib/config'
import { normalizeCustomerDesign } from '../../render-library/views'
import { resolveNativeCamera } from './privateScene'

describe('native room-overview camera', () => {
  it.each([
    ['studio', 20],
    ['studio', 40],
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

  it.each([20, 40] as const)(
    'looks through every %s ft Container opening from outside',
    (lengthFt) => {
      const base = defaultDesign({ family: 'container', lengthFt })
      for (const opening of ['roll-up', 'center', 'partial', 'full'] as const)
        for (const infill of ['none', 'glass-overhead', 'awning'] as const)
          for (const aspect of ['wide', 'tall'] as const) {
            if (opening === 'roll-up' && infill !== 'none') continue
            const design = normalizeCustomerDesign({
              ...base,
              config: { ...base.config, structure: { ...base.config.structure, opening, infill } },
              presentation: { ...base.presentation, aspect, cameraRef: 'entry-draft@1' },
            })
            const config = projectDesignToConfig(design)
            const aperture = openingGeometry(config)
            const camera = resolveNativeCamera(design)
            expect(camera.position[2]).toBeGreaterThan(4)
            expect(camera.position[0]).toBe(aperture.center)
            expect(camera.target[0]).toBe(aperture.center)
            expect(camera.target[2]).toBeLessThan(interiorBounds(config).front)
            expect(config.doorsOpen).toBe(opening === 'roll-up' || infill !== 'none')
            const lens = new PerspectiveCamera(
              camera.fov,
              ASPECT_RATIO[aspect],
              camera.near,
              camera.far,
            )
            lens.position.fromArray(camera.position)
            lens.lookAt(new Vector3(...camera.target))
            lens.updateMatrixWorld()
            for (const x of [
              aperture.center - aperture.width / 2,
              aperture.center + aperture.width / 2,
            ])
              for (const y of [0.96, productHeight(config) - 0.9]) {
                const point = new Vector3(x, y, 4).project(lens)
                expect(Math.abs(point.x)).toBeLessThan(1)
                expect(Math.abs(point.y)).toBeLessThan(1)
                expect(point.z).toBeGreaterThan(-1)
                expect(point.z).toBeLessThan(1)
              }
          }
    },
  )

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
