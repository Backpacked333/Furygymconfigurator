import { describe, expect, it, vi } from 'vitest'
import {
  QUALITY_DETAILS,
  defaultQuality,
  requestedBackend,
  requestedQuality,
  createQualityGovernor,
  sampleQuality,
  resetQualitySampling,
  type DeviceProfile,
} from './quality'
import { textureProgress } from './progress'

describe('render quality selection', () => {
  it('starts unknown devices conservatively, independently of viewport width', () => {
    expect(defaultQuality(1440, '')).toBe('lite')
    expect(defaultQuality(1100, '')).toBe('lite')
    expect(defaultQuality(900, '')).toBe('lite')
    expect(defaultQuality(390, '')).toBe('lite')
  })
  it('honours an explicit ?quality= tier and ignores unknown values', () => {
    expect(defaultQuality(390, '?quality=ultra')).toBe('ultra')
    expect(defaultQuality(1440, '?quality=lite')).toBe('lite')
    expect(defaultQuality(1440, '?quality=cinematic')).toBe('lite')
    expect(requestedQuality('?quality=cinematic')).toBeNull()
    expect(requestedQuality('?quality=auto')).toBeNull()
  })
  it('lets ?renderer= force a GPU backend', () => {
    expect(requestedBackend('?renderer=webgl')).toBe('webgl2')
    expect(requestedBackend('?renderer=webgl2')).toBe('webgl2')
    expect(requestedBackend('?renderer=webgpu')).toBe('webgpu')
    expect(requestedBackend('')).toBeNull()
    expect(requestedBackend('?renderer=vulkan')).toBeNull()
  })
  it('describes every tier', () => {
    for (const detail of Object.values(QUALITY_DETAILS)) expect(detail.length).toBeGreaterThan(20)
  })
})

describe('measured Auto policy', () => {
  const capable: DeviceProfile = {
    backend: 'webgpu',
    hardware: 'capable',
    maxTextureSize: 8192,
    memoryBudgetMB: 1536,
  }
  it('requires an initialized backend and capable profile to start High', () => {
    expect(defaultQuality(390, '', capable)).toBe('high')
    expect(defaultQuality(2000, '', { ...capable, backend: undefined })).toBe('lite')
    expect(defaultQuality(2000, '', { ...capable, hardware: 'software' })).toBe('lite')
    expect(defaultQuality(390, '?quality=ultra', { ...capable, hardware: 'software' })).toBe(
      'ultra',
    )
  })
  const run = (frames: number, ms: number, state = createQualityGovernor('ultra'), start = 0) => {
    for (let i = 0; i < frames; i++) state = sampleQuality(state, ms, start + i * ms)
    return state
  }
  it('warms up and requires three complete slow windows before downshift', () => {
    const before = run(209, 60)
    expect(before.tier).toBe('ultra')
    const after = sampleQuality(before, 60, 210 * 60)
    expect(after.tier).toBe('high')
    expect(after.cooldownUntil).toBe(210 * 60 + 15000)
  })
  it('resets hysteresis after a fast window and ignores idle/hidden gaps', () => {
    const slow = run(150, 60)
    expect(slow.slowWindows).toBe(2)
    expect(run(60, 16, slow).slowWindows).toBe(0)
    expect(sampleQuality(slow, 60, 10000, false).warmup).toBe(30)
    expect(sampleQuality(slow, 5000, 10000).samples).toEqual([])
    expect(resetQualitySampling(slow).slowWindows).toBe(0)
  })
  it('does not oscillate upward or downgrade explicit choices', () => {
    expect(run(1000, 16, createQualityGovernor('lite')).tier).toBe('lite')
    expect(run(1000, 150, createQualityGovernor('ultra', 'ultra')).tier).toBe('ultra')
    const high = run(210, 60)
    expect(run(200, 60, high, 12600).tier).toBe('high')
  })
})

describe('material streaming progress', () => {
  it('accumulates requested and loaded maps and notifies subscribers', () => {
    const listener = vi.fn()
    const stop = textureProgress.subscribe(listener)
    const before = textureProgress.get()
    textureProgress.update(3, 0)
    textureProgress.update(0, 2)
    expect(textureProgress.get()).toEqual({
      requested: before.requested + 3,
      loaded: before.loaded + 2,
    })
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    textureProgress.update(0, 1)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
