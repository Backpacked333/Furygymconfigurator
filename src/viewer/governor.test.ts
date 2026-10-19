// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DEMOTE_ABOVE, FrameGovernor, PROMOTE_BELOW, lower, tierMemory } from './governor'

const feed = (g: FrameGovernor, kind: 'motion' | 'rest', ms: number, n = 16) => {
  let verdict = null
  for (let i = 0; i < n && !verdict; i++) verdict = g.sample(kind, ms)
  return verdict
}

describe('frame governor', () => {
  it('steps down when motion frames miss the smoothness budget', () => {
    expect(feed(new FrameGovernor('high'), 'motion', DEMOTE_ABOVE.motion.high + 5)).toBe('demote')
    expect(feed(new FrameGovernor('ultra'), 'motion', DEMOTE_ABOVE.motion.ultra + 5)).toBe('demote')
  })
  it('steps down when the picture takes too long to sharpen', () => {
    expect(feed(new FrameGovernor('high'), 'rest', DEMOTE_ABOVE.rest.high + 5)).toBe('demote')
  })
  it('leaves Lite alone: there is nothing lower', () => {
    expect(feed(new FrameGovernor('lite'), 'motion', 200)).toBeNull()
  })
  it('judges the median, so a few slow frames (a compile, a GC) do not count', () => {
    const g = new FrameGovernor('high')
    for (let i = 0; i < 5; i++) g.sample('motion', 300)
    expect(feed(g, 'motion', 8, 11)).toBeNull()
  })
  it('promotes a fast High device once both kinds of frame are quick, only if allowed', () => {
    const fast = { motion: PROMOTE_BELOW.motion - 2, rest: PROMOTE_BELOW.rest - 2 }
    const allowed = new FrameGovernor('high', { promote: true })
    expect(feed(allowed, 'motion', fast.motion)).toBeNull()
    expect(feed(allowed, 'rest', fast.rest)).toBe('promote')
    const pinned = new FrameGovernor('high')
    feed(pinned, 'motion', fast.motion)
    expect(feed(pinned, 'rest', fast.rest)).toBeNull()
  })
  it('decides at most once', () => {
    const g = new FrameGovernor('high')
    expect(feed(g, 'motion', 50)).toBe('demote')
    expect(feed(g, 'motion', 50)).toBeNull()
  })
  it('steps Ultra to High and High to Lite', () => {
    expect(lower('ultra')).toBe('high')
    expect(lower('high')).toBe('lite')
  })
})

describe('tier memory', () => {
  beforeEach(() => localStorage.clear())
  it('remembers the tier per GPU', () => {
    expect(tierMemory.get('gpu-a')).toBeNull()
    tierMemory.set('gpu-a', 'ultra')
    tierMemory.set('gpu-b', 'lite')
    expect(tierMemory.get('gpu-a')).toBe('ultra')
    expect(tierMemory.get('gpu-b')).toBe('lite')
  })
  it('forgets unreadable entries instead of failing', () => {
    localStorage.setItem('viewer360:tier', '{not json')
    expect(tierMemory.get('gpu-a')).toBeNull()
  })
})
