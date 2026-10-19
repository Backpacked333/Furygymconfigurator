import { describe, expect, it, vi } from 'vitest'
import { sceneProgress } from './progress'

describe('scene start-up progress', () => {
  it('moves through its phases and is ready once a frame is drawn', () => {
    const listener = vi.fn()
    const stop = sceneProgress.subscribe(listener)
    expect(sceneProgress.get()).toBe('engine')
    sceneProgress.set('renderer')
    sceneProgress.set('shaders')
    sceneProgress.drawn()
    expect(sceneProgress.get()).toBe('ready')
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
  })

  it('runs after-draw callbacks once, unless cancelled', () => {
    const once = vi.fn()
    const cancelled = vi.fn()
    sceneProgress.afterNextDraw(once)
    sceneProgress.afterNextDraw(cancelled)()
    sceneProgress.drawn()
    sceneProgress.drawn()
    expect(once).toHaveBeenCalledTimes(1)
    expect(cancelled).not.toHaveBeenCalled()
  })
})
