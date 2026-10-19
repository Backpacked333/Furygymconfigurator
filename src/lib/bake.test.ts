// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bakeDesigns, bakeMode, bakeRefusal, heroOf } from './bake'
import { bakedStill } from './bakedStills'
import {
  DEFAULT_CAMERA,
  DEFAULT_CONFIG,
  FINISHES,
  SIGNATURES,
  decodeConfig,
  type Config,
} from './config'
import { configKey } from './stillKey'
import type { StillsManifest } from './stillsManifest'
import { bakeJobs } from '../render/bake'
import { angleKey } from '../render/gallery'

const LOCAL = 'cloud=http://127.0.0.1:4190/render'

describe('bake mode', () => {
  it('is off on an ordinary visit, and reads its options from the address', () => {
    expect(bakeMode('', true)).toBeNull()
    expect(bakeMode('?bake=0', true)).toBeNull()
    expect(bakeMode(`?bake=1&${LOCAL}`, true)).toEqual({
      list: false,
      quick: false,
      hero: null,
      aspects: ['wide', 'tall'],
    })
    expect(bakeMode(`?bake=1&quick=1&hero=0.16,0.12,1&aspects=tall&${LOCAL}`, true)).toEqual({
      list: false,
      quick: true,
      hero: [0.16, 0.12, 1],
      aspects: ['tall'],
    })
    expect(bakeMode('?bake=list', true)?.list).toBe(true)
    // Nonsense falls back to the defaults.
    expect(bakeMode(`?bake=1&hero=a,b&aspects=square&${LOCAL}`, true)).toMatchObject({
      hero: null,
      aspects: ['wide', 'tall'],
    })
  })

  it('runs only in an automated browser, on a render server of its own machine', () => {
    // Anyone opening ?bake=1 on the site: an ordinary visit, with no GPU set to work.
    expect(bakeMode(`?bake=1&${LOCAL}`, false)).toBeNull()
    expect(bakeRefusal(`?bake=1&${LOCAL}`, false)).toMatch(/bake-stills/)
    // Driven by a script, but at the site's own renderer, or another's.
    for (const cloud of ['', '&cloud=https://render.example.com', '&cloud=http://10.0.0.2:8787']) {
      expect(bakeMode(`?bake=1${cloud}`, true)).toBeNull()
      expect(bakeRefusal(`?bake=1${cloud}`, true)).toMatch(/this machine/)
    }
    expect(bakeRefusal(`?bake=1&cloud=http://localhost:8787`, true)).toBeNull()
    expect(bakeRefusal('?bake=list', true)).toBeNull()
    expect(bakeRefusal('', false)).toBeNull()
  })

  it('lists the default design and the signature builds, then every other finish of each', () => {
    const designs = bakeDesigns()
    const own = designs.filter((d) => !d.variant)
    expect(own.map((d) => d.id)).toEqual([
      'default',
      'default-container',
      ...SIGNATURES.map((s) => s.id),
    ])
    expect(own[0]).toMatchObject({ group: 'default', hero: null, finish: DEFAULT_CONFIG.finish })
    expect(configKey(decodeConfig(own[0].encoded)!)).toBe(configKey(DEFAULT_CONFIG))
    expect(decodeConfig(own[1].encoded)?.family).toBe('container')
    own.slice(2).forEach((design, i) => {
      expect(design).toMatchObject({ group: 'signature', hero: SIGNATURES[i].camera })
      expect(configKey(decodeConfig(design.encoded)!)).toBe(configKey(SIGNATURES[i].config))
    })
    expect(designs).toHaveLength(own.length * FINISHES.length)
    const graphite = designs.find((d) => d.id === 'default+graphite')!
    expect(graphite).toMatchObject({ variant: true, finish: 'graphite', group: 'default' })
    expect(decodeConfig(graphite.encoded)).toEqual({ ...DEFAULT_CONFIG, finish: 'graphite' })
    expect(new Set(designs.map((d) => d.id)).size).toBe(designs.length)
  })

  it('frames a signature build from its photograph, however it is opened', () => {
    expect(heroOf(DEFAULT_CONFIG)).toEqual(DEFAULT_CAMERA)
    for (const design of bakeDesigns()) {
      const config = decodeConfig(design.encoded)!
      expect(heroOf(config)).toEqual(design.hero ?? DEFAULT_CAMERA)
    }
    // Changed in anything but its finish, a signature build is a design of the visitor's own.
    const pod = SIGNATURES[0].config
    expect(heroOf({ ...pod, finish: 'graphite' })).toEqual(SIGNATURES[0].camera)
    expect(heroOf({ ...pod, items: [] } as Config)).toEqual(DEFAULT_CAMERA)
  })

  it("finds a shared signature build's baked front three-quarter still", () => {
    const signature = SIGNATURES[1]
    // Opened from a share link (#c=), as it was baked.
    const opened = decodeConfig(bakeDesigns().find((d) => d.id === signature.id)!.encoded)!
    const jobs = bakeJobs({
      config: signature.config,
      hero: signature.camera,
      aspects: ['wide'],
      near: 0.1,
      far: 900,
    })
    const hero = jobs.find((job) => job.angle === 'front-left')!
    const manifest: StillsManifest = {
      version: 'v1',
      widths: [320],
      stills: {
        [configKey(signature.config)]: {
          [`${hero.angleKey}|wide`]: ['abcd0123', 2400, 1500, 1024],
        },
      },
    }
    const key = angleKey('front-left', heroOf(opened))
    expect(key).toBe(hero.angleKey)
    expect(bakedStill(configKey(opened), key, 'wide', manifest, 'v1')).not.toBeNull()
    // The default direction would miss it.
    expect(
      bakedStill(configKey(opened), angleKey('front-left', DEFAULT_CAMERA), 'wide', manifest, 'v1'),
    ).toBeNull()
  })
})
