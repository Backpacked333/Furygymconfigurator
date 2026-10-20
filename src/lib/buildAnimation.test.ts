import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildAnimation } from './buildAnimation'
import { DEFAULT_CONFIG, type Config } from './config'

describe('the supplied build animations', () => {
  const cases: [Partial<Config>, string][] = [
    [{ family: 'container', containerOpening: 'roll-up' }, 'container'],
    [{ family: 'container', containerOpening: 'center' }, 'container-center'],
    [{ family: 'container', containerOpening: 'partial' }, 'container-partial'],
    [{ family: 'container', containerOpening: 'full' }, 'container-full'],
    [{ family: 'container', length: 40 }, 'container-40'],
    [{}, 'studio-single'],
    [{ length: 40 }, 'studio-long'],
    [{ studioLayout: 'double-wide' }, 'studio-double'],
    [{ studioLayout: 'connected' }, 'studio-double'],
    [{ studioLayout: 'multi-level' }, 'studio-stacked'],
    [{ studioLayout: 'stacked' }, 'studio-stacked'],
    [{ addons: { ...DEFAULT_CONFIG.addons, deck: true } }, 'studio-deck'],
    [{ addons: { ...DEFAULT_CONFIG.addons, roof: true } }, 'studio-roof'],
    [
      { addons: { ...DEFAULT_CONFIG.addons, deck: true, gazebo: true, roof: true, stairs: true } },
      'studio-full',
    ],
  ]
  it.each(cases)('matches the closest assembly for %j', (config, expected) => {
    expect(buildAnimation({ ...DEFAULT_CONFIG, ...config })).toBe(expected)
    const path = `public/builds/${expected}.html`
    expect(existsSync(path)).toBe(true)
    const source = readFileSync(path, 'utf8')
    expect(source).toContain('prefers-reduced-motion')
    expect(source).toContain('IntersectionObserver')
    expect(source).not.toMatch(/<script[^>]+src=/i)
  })
  it('uses No excuses for general startup', () => {
    expect(buildAnimation()).toBe('no-excuses')
    expect(existsSync('public/builds/no-excuses.html')).toBe(true)
  })
})
