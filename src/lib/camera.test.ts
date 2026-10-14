import { describe, expect, it } from 'vitest'
import {
  canRestoreCamera,
  transitionFraction,
  presentationFrame,
  captureFov,
  fitCameraToBounds,
  type CameraSnapshot,
} from './camera'
import { PerspectiveCamera, Vector3 } from 'three'
import { DEFAULT_CONFIG } from './config'
import { presentationBounds } from './spatial'

describe('persistent camera contract', () => {
  const snapshot: CameraSnapshot = {
    bounds: 'studio:20',
    reset: 0,
    fov: 32,
    position: [1, 2, 3],
    quaternion: [0, 0, 0, 1],
    target: [0, 0, 0],
  }
  it('restores across ordinary appearance edits but refits structural bounds or deliberate reset', () => {
    expect(canRestoreCamera(snapshot, 'studio:20', 0)).toBe(true)
    expect(canRestoreCamera(snapshot, 'studio:40', 0)).toBe(false)
    expect(canRestoreCamera(snapshot, 'studio:20', 1)).toBe(false)
    expect(canRestoreCamera(undefined, 'studio:20', 0)).toBe(false)
  })
  it('uses bounded elapsed-time transitions and honors reduced motion', () => {
    expect(transitionFraction(-1, false)).toBe(0)
    expect(transitionFraction(0.325, false)).toBeCloseTo(0.5)
    expect(transitionFraction(2, false)).toBe(1)
    expect(transitionFraction(0, true)).toBe(1)
  })
})
describe('native centered framing', () => {
  it('fits a 16:9 crop in a 4:3 viewport without stretch', () => {
    expect(presentationFrame(1600, 1200)).toEqual({ x: 0, y: 0.125, width: 1, height: 0.75 })
    const fov = captureFov(60, 4 / 3, 16 / 9)
    expect(Math.tan((fov * Math.PI) / 360) / Math.tan(Math.PI / 6)).toBeCloseTo(0.75)
  })
  it('crops horizontal coverage for an ultrawide viewport, preserving vertical FOV', () => {
    expect(presentationFrame(2400, 1000).height).toBe(1)
    expect(presentationFrame(2400, 1000).width).toBeCloseTo(16 / 9 / 2.4)
    expect(captureFov(60, 2.4, 16 / 9)).toBe(60)
    expect(presentationFrame(0, 0)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

describe('geometry-backed exterior camera fitting', () => {
  it('contains site context and multilevel access at laptop and narrow aspect ratios', () => {
    for (const family of ['studio', 'container'] as const)
      for (const length of [20, 40] as const)
        for (const context of ['product', 'custom-wellness', 'sunken-lounge'] as const)
          for (const aspect of [0.5, 1, 16 / 9, 2.4]) {
            const bounds = presentationBounds({
              ...DEFAULT_CONFIG,
              family,
              length,
              items: [],
              addons: { deck: true, roof: true, stairs: true, gazebo: family === 'studio' },
              presentation: { openingPose: 'open', context },
            })
            const fit = fitCameraToBounds(bounds, aspect)
            const camera = new PerspectiveCamera(32, aspect, 0.1, 1000)
            camera.position.fromArray(fit.position)
            camera.lookAt(new Vector3(...fit.target))
            camera.updateMatrixWorld()
            for (const x of [bounds.min.x, bounds.max.x])
              for (const y of [bounds.min.y, bounds.max.y])
                for (const z of [bounds.min.z, bounds.max.z]) {
                  const projected = new Vector3(x, y, z).project(camera)
                  expect(Math.abs(projected.x)).toBeLessThan(1)
                  expect(Math.abs(projected.y)).toBeLessThan(1)
                  expect(projected.z).toBeGreaterThan(-1)
                  expect(projected.z).toBeLessThan(1)
                }
          }
  })
})
