// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GAP_MS, createBootStats } from './bootStats'

let now = 0
let frames: FrameRequestCallback[] = []
const tick = (ms: number) => {
  now += ms
  const due = frames
  frames = []
  due.forEach((callback) => callback(now))
}

beforeEach(() => {
  now = 1000
  frames = []
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
  performance.clearMarks()
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('?bootStats=1', () => {
  it('is inert without the flag: no panel, no frame watcher, nothing recorded', () => {
    const stats = createBootStats(false, document)
    stats.start({ quality: 'high' })
    stats.step('anything')
    stats.restart('camera moved')
    expect(stats.running).toBe(false)
    expect(document.querySelector('[data-boot-stats]')).toBeNull()
    expect(frames).toHaveLength(0)
  })

  it('times steps from the press of 360°, in order, with the view’s context', () => {
    performance.mark('fury:live-click', { startTime: 400 })
    const stats = createBootStats(true, document)
    stats.start()
    stats.context('gpu', 'apple / metal-3')
    now = 1600
    stats.step('raster shaders compiled')
    now = 2500
    stats.step('first batch finished on the GPU')
    // A step reported late, at the time it happened.
    stats.step('360° view code loaded', 700)
    const lines = stats.text().split('\n')
    expect(lines).toContain('gpu: apple / metal-3')
    const steps = lines.filter((line) => /^ *\+\d/.test(line))
    expect(steps.map((line) => line.trim())).toEqual([
      '+0.30 s  360° view code loaded',
      '+0.60 s  view mounted',
      '+1.20 s  raster shaders compiled',
      '+2.10 s  first batch finished on the GPU',
    ])
    expect(document.querySelector('[data-boot-stats]')).not.toBeNull()
    stats.stop()
  })

  it('counts restarts by reason and frames that stalled', () => {
    const stats = createBootStats(true, document)
    stats.start()
    stats.restart('scans arrived')
    stats.restart('scans arrived')
    stats.restart('camera moved')
    tick(16)
    tick(16)
    tick(GAP_MS + 150)
    tick(16)
    const text = stats.text()
    expect(text).toContain('Trace restarts: scans arrived ×2, camera moved ×1')
    expect(text).toContain(`Stalled frames (≥${GAP_MS} ms): 1, 250 ms in all, longest 250 ms`)
    stats.stop()
    expect(frames).toHaveLength(0)
  })

  it('starts over for each view, and logs the whole timeline when the view settles', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const stats = createBootStats(true, document)
    stats.start()
    stats.restart('camera moved')
    stats.start()
    expect(stats.text()).toContain('Trace restarts: none')
    stats.settled()
    expect(info).toHaveBeenCalledWith(stats.text())
    expect(stats.text()).toContain('settled')
    stats.stop()
    expect(stats.running).toBe(false)
  })

  it('copies exactly what the panel shows', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const stats = createBootStats(true, document)
    stats.start()
    stats.step('sky map ready')
    const copy = [...document.querySelectorAll('[data-boot-stats] button')].find(
      (button) => button.textContent === 'Copy',
    ) as HTMLButtonElement
    copy.click()
    expect(writeText).toHaveBeenCalledWith(stats.text())
    stats.stop()
  })
})
