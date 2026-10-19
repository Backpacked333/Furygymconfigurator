import { describe, expect, it } from 'vitest'
import { Convergence } from './convergence'
import { cubeSize, reusable } from './cube'

describe('convergence', () => {
  it('runs the full window after a camera or content change', () => {
    const c = new Convergence(14)
    c.change('camera')
    let frames = 1
    while (c.drawn()) frames++
    expect(frames).toBe(14)
    c.change('content')
    expect(c.remaining).toBe(14)
  })
  it('does not start over when textures or a probe arrive mid-run', () => {
    const c = new Convergence(20)
    c.change('camera')
    for (let i = 0; i < 15; i++) c.drawn()
    c.change('textures')
    expect(c.remaining).toBe(10)
    c.change('probe')
    expect(c.remaining).toBe(10)
  })
  it('gives a late arrival after convergence half a run', () => {
    const c = new Convergence(20)
    c.change('environment')
    expect(c.remaining).toBe(10)
  })
})

describe('probe targets', () => {
  it('match the power-of-two cube PMREM actually allocates', () => {
    expect(cubeSize(192)).toBe(128)
    expect(cubeSize(128)).toBe(128)
    expect(cubeSize(64)).toBe(64)
  })
  it('are reused across captures of the same size (the old check reallocated every time)', () => {
    expect(reusable({ height: 4 * 128 }, 192)).toBe(true)
    expect(reusable({ height: 4 * 128 }, 128)).toBe(true)
    expect(reusable({ height: 4 * 64 }, 128)).toBe(false)
    expect(reusable(null, 128)).toBe(false)
  })
})
