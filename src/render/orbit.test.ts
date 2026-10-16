import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  AZIMUTH_STEPS,
  ORBIT_LIMITS,
  ViewCache,
  blendPosition,
  orbitCoordinates,
  poseAt,
  poseMatrix,
  posePosition,
  ringKey,
  ringOrder,
  snapPose,
} from './orbit'

const target = new Vector3(1, 4, -2)
const step = (2 * Math.PI) / AZIMUTH_STEPS

/** A camera position at orbit angles (radians) and distance around the target. */
function at(theta: number, phi: number, radius: number) {
  return new Vector3(
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.cos(theta),
  ).add(target)
}

describe('orbit grid', () => {
  it('round-trips grid poses through camera positions', () => {
    const pose = { azimuth: 7, polar: 12, radius: 20 }
    const position = posePosition(target, pose)
    expect(poseAt(position, target)).toEqual(pose)
    // Between poses there is no grid pose to show.
    expect(poseAt(at(7.4 * step, 1, 40), target)).toBeNull()
  })

  it('rests on the nearest pose, within the orbit limits', () => {
    const pose = snapPose(at(10.3 * step, 1.05, 40), target, null)
    expect(pose.azimuth).toBe(10)
    const { phi, radius } = orbitCoordinates(posePosition(target, pose), target)
    expect(Math.abs(phi - 1.05)).toBeLessThan((2.5 * Math.PI) / 180 + 1e-9)
    expect(radius / 40).toBeGreaterThan(1 / 1.031)
    expect(radius / 40).toBeLessThan(1.031)
    // Out of range: clamped to the closest pose OrbitControls allows.
    const low = snapPose(at(0, Math.PI / 2, 500), target, null)
    const clamped = orbitCoordinates(posePosition(target, low), target)
    expect(clamped.phi).toBeLessThanOrEqual(ORBIT_LIMITS.maxPolarAngle)
    expect(clamped.radius).toBeLessThanOrEqual(ORBIT_LIMITS.maxDistance)
  })

  it('never undoes a small deliberate move', () => {
    const last = { azimuth: 10, polar: 12, radius: 20 }
    const rest = posePosition(target, last)
    const { phi, radius } = orbitCoordinates(rest, target)
    // A third of a step left would round back; it advances one step instead.
    expect(snapPose(at(10.33 * step, phi, radius), target, last).azimuth).toBe(11)
    expect(snapPose(at(9.7 * step, phi, radius), target, last).azimuth).toBe(9)
    // Too small to be deliberate (float noise, a tap): stays put.
    expect(snapPose(at(10.05 * step, phi, radius), target, last).azimuth).toBe(10)
  })

  it('wraps the azimuth the short way round', () => {
    const last = { azimuth: 0, polar: 12, radius: 20 }
    const { phi, radius } = orbitCoordinates(posePosition(target, last), target)
    expect(snapPose(at(-0.4 * step, phi, radius), target, last).azimuth).toBe(AZIMUTH_STEPS - 1)
    const from = at(-0.4 * step, phi, radius)
    const pose = { ...last, azimuth: AZIMUTH_STEPS - 1 }
    // Halfway there it is between the two, not on the far side of the building.
    const mid = orbitCoordinates(blendPosition(target, from, pose, 0.5), target)
    expect(Math.abs(mid.theta + 0.7 * step)).toBeLessThan(1e-9)
    expect(blendPosition(target, from, pose, 0).distanceTo(from)).toBeLessThan(1e-9)
    expect(
      blendPosition(target, from, pose, 1).distanceTo(posePosition(target, pose)),
    ).toBeLessThan(1e-9)
  })

  it('matches the camera OrbitControls would place there', () => {
    const pose = { azimuth: 30, polar: 9, radius: 25 }
    const camera = new PerspectiveCamera()
    camera.position.copy(posePosition(target, pose))
    camera.lookAt(target)
    camera.updateMatrixWorld()
    const matrix = poseMatrix(target, pose)
    matrix.elements.forEach((v, i) => expect(v).toBeCloseTo(camera.matrixWorld.elements[i], 9))
  })

  it('pre-renders the nearest azimuths first, and all of them', () => {
    const order = ringOrder(1)
    expect(order.slice(0, 5)).toEqual([1, 2, 0, 3, AZIMUTH_STEPS - 1])
    expect(new Set(order).size).toBe(AZIMUTH_STEPS)
  })

  it('keys a ring by everything that changes its images', () => {
    const pose = { azimuth: 3, polar: 12, radius: 20 }
    const key = ringKey('scene', target, pose, 34, '1920x1200')
    expect(ringKey('scene', target, { ...pose, azimuth: 9 }, 34, '1920x1200')).toBe(key)
    for (const other of [
      ringKey('edited', target, pose, 34, '1920x1200'),
      ringKey('scene', target, { ...pose, polar: 13 }, 34, '1920x1200'),
      ringKey('scene', target, { ...pose, radius: 21 }, 34, '1920x1200'),
      ringKey('scene', new Vector3(0, 4, -2), pose, 34, '1920x1200'),
      ringKey('scene', target, pose, 40, '1920x1200'),
      ringKey('scene', target, pose, 34, '1280x800'),
    ])
      expect(other).not.toBe(key)
  })
})

describe('view cache', () => {
  const frame = (size: number) => ({ bytes: new Uint8Array(size) })

  it('drops the least recently used views beyond its budget', () => {
    const cache = new ViewCache(10)
    cache.set('a', frame(4))
    cache.set('b', frame(4))
    cache.get('a')
    cache.set('c', frame(4))
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
    expect(cache.bytes).toBe(8)
    cache.set('c', frame(2))
    expect(cache.bytes).toBe(6)
  })

  it('keeps a view larger than the budget until the next one', () => {
    const cache = new ViewCache(10)
    cache.set('big', frame(20))
    expect(cache.has('big')).toBe(true)
    cache.set('small', frame(1))
    expect(cache.has('big')).toBe(false)
  })
})
