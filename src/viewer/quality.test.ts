import { describe, expect, it, vi } from 'vitest'
import { QUALITY_DETAILS, defaultQuality, isConstrained, requestedBackend } from './quality'
import { textureProgress } from './progress'

const laptop = { coarsePointer: false, memory: 8, cores: 10 }

describe('render quality selection', () => {
  it('starts by device, never by screen: High on laptops, Lite on phones, tablets, low-end', () => {
    expect(defaultQuality(laptop, '')).toBe('high')
    expect(defaultQuality({ coarsePointer: false }, '')).toBe('high')
    expect(defaultQuality({ ...laptop, coarsePointer: true }, '')).toBe('lite')
    expect(defaultQuality({ ...laptop, memory: 4 }, '')).toBe('lite')
    expect(defaultQuality({ ...laptop, cores: 4 }, '')).toBe('lite')
    expect(defaultQuality({ ...laptop, saveData: true }, '')).toBe('lite')
  })
  it('never starts on Ultra: a device earns it by drawing High quickly', () => {
    for (const memory of [8, 16, 32])
      expect(defaultQuality({ ...laptop, memory }, '')).not.toBe('ultra')
  })
  it('honours an explicit ?quality= tier and ignores unknown values', () => {
    expect(defaultQuality({ ...laptop, coarsePointer: true }, '?quality=ultra')).toBe('ultra')
    expect(defaultQuality(laptop, '?quality=lite')).toBe('lite')
    expect(defaultQuality(laptop, '?quality=cinematic')).toBe('high')
  })
  it('treats unknown signals as unconstrained', () => {
    expect(isConstrained({ coarsePointer: false })).toBe(false)
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
