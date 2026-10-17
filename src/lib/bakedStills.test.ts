import { describe, expect, it, vi } from 'vitest'
import { bakedGains, bakedStill, forgetBaked } from './bakedStills'
import { DEFAULT_CONFIG, encodeConfig } from './config'
import { RENDER_VERSION, configKey } from './stillKey'
import {
  EMPTY_MANIFEST,
  STILL_SIZES,
  TALL_MEDIA,
  heroPreloadScript,
  manifestHead,
  manifestProblems,
  withRest,
  type StillsManifest,
} from './stillsManifest'

const design = configKey(DEFAULT_CONFIG)
const other = '0123456789abcdef'
const manifest: StillsManifest = {
  version: 'v1',
  base: '/stills/v1',
  widths: [320, 640, 960],
  hero: { design, encoded: encodeConfig(DEFAULT_CONFIG) },
  looks: { 'meadow|0,1,0|0.000': { exterior: 1.25, interior: 1.5 } },
  stills: {
    [design]: {
      'front-left|wide': ['aaaa1111', 2400, 1500, 1024],
      'front-left|tall': ['bbbb2222', 1920, 2400, 1024],
      'rear|wide': ['cccc3333', 2400, 1500, 1024],
    },
    [other]: {
      'front-left~0.160,0.120,1.000|wide': ['dddd4444', 640, 400, 64],
    },
  },
}
const at = (file: string) => `/stills/v1/${design}/${file}`

describe('baked stills', () => {
  it('are found from the design, the angle and the stage shape alone', () => {
    const still = bakedStill(design, 'front-left', 'wide', manifest, 'v1')!
    expect(still).toEqual({
      url: at('front-left-wide-2400.aaaa1111.webp'),
      srcset: [320, 640, 960, 2400]
        .map((w) => `${at(`front-left-wide-${w}.aaaa1111.webp`)} ${w}w`)
        .join(', '),
      sizes: STILL_SIZES.wide,
      thumb: at('front-left-wide-320.aaaa1111.webp'),
      width: 2400,
      height: 1500,
      samples: 1024,
      tier: 'export',
    })
    // The other shape is another still, with its own sizes.
    const tall = bakedStill(design, 'front-left', 'tall', manifest, 'v1')!
    expect(tall.url).toBe(at('front-left-tall-1920.bbbb2222.webp'))
    expect(tall.sizes).toBe(STILL_SIZES.tall)
    expect(bakedStill(design, 'rear', 'wide', manifest, 'v1')!.url).toBe(
      at('rear-wide-2400.cccc3333.webp'),
    )
    // An angle, shape or design not baked has none.
    expect(bakedStill(design, 'rear', 'tall', manifest, 'v1')).toBeNull()
    expect(bakedStill(design, 'top', 'wide', manifest, 'v1')).toBeNull()
    expect(bakedStill('fedcba9876543210', 'front-left', 'wide', manifest, 'v1')).toBeNull()
    expect(bakedStill('', 'front-left', 'wide', manifest, 'v1')).toBeNull()
    // A signature build's own front ¾ view is another angle key, its file named safely.
    const signature = bakedStill(other, 'front-left~0.160,0.120,1.000', 'wide', manifest, 'v1')!
    expect(signature.url).toBe(
      `/stills/v1/${other}/front-left_0_160_0_120_1_000-wide-640.dddd4444.webp`,
    )
    expect(bakedStill(design, 'front-left~0.160,0.120,1.000', 'wide', manifest, 'v1')).toBeNull()
  })

  it('serve from wherever they were stored', () => {
    const blob = { ...manifest, base: 'https://store.example/stills/v1' }
    expect(bakedStill(design, 'rear', 'wide', blob, 'v1')!.url).toBe(
      `https://store.example/stills/v1/${design}/rear-wide-2400.cccc3333.webp`,
    )
  })

  it('count a quick bake as a stand-in, never as finished', () => {
    const quick = bakedStill(other, 'front-left~0.160,0.120,1.000', 'wide', manifest, 'v1')!
    expect(quick).toMatchObject({ tier: 'thumb', samples: 64, width: 640 })
    // Below the narrowest width: the master alone.
    expect(quick.srcset.split(', ')).toHaveLength(2)
  })

  it('are ignored whole when baked by another renderer version', () => {
    expect(bakedStill(design, 'front-left', 'wide', manifest, 'v2')).toBeNull()
    expect(bakedGains('meadow|0,1,0|0.000', manifest, 'v2')).toBeNull()
    // The bundled manifest is not of the tests' version.
    expect(RENDER_VERSION).toBe('test')
    expect(bakedStill(design, 'front-left', 'wide')).toBeNull()
  })

  it("give a look's baked gains", () => {
    expect(bakedGains('meadow|0,1,0|0.000', manifest, 'v1')).toEqual({
      exterior: 1.25,
      interior: 1.5,
    })
    expect(bakedGains('desert|0,1,0|0.000', manifest, 'v1')).toBeNull()
    expect(bakedGains('meadow|0,1,0|0.000', { version: 'v1', stills: {} }, 'v1')).toBeNull()
  })

  it('are forgotten once one fails to load', () => {
    const lost: StillsManifest = {
      ...manifest,
      stills: { [design]: { 'top|wide': ['eeee5555', 2400, 1500, 1024] } },
    }
    const still = bakedStill(design, 'top', 'wide', lost, 'v1')!
    forgetBaked(still.url)
    expect(bakedStill(design, 'top', 'wide', lost, 'v1')).toBeNull()
  })
})

describe('the baked stills manifest in the build', () => {
  it('puts only the hero stills in the entry chunk, and says whether more follow', () => {
    const head = manifestHead(manifest, 'v1')
    expect(head.stills).toEqual({
      [design]: {
        'front-left|wide': manifest.stills[design]['front-left|wide'],
        'front-left|tall': manifest.stills[design]['front-left|tall'],
      },
    })
    expect(head).toMatchObject({ version: 'v1', base: '/stills/v1', looks: manifest.looks })
    expect(head.hero).toEqual({ design, encoded: '' })
    expect(head.more).toBe(true)
    const heroOnly = { ...manifest, stills: { [design]: head.stills[design] } }
    expect(manifestHead(heroOnly, 'v1').more).toBe(false)
    // Another version's is nothing at all.
    expect(manifestHead(manifest, 'v2')).toEqual({ ...EMPTY_MANIFEST, more: false })
    expect(manifestHead(EMPTY_MANIFEST, '')).toEqual({ ...EMPTY_MANIFEST, more: false })
  })

  it("keeps the hero design's other angles once the rest has loaded", () => {
    const whole = withRest(manifestHead(manifest, 'v1'), { stills: manifest.stills })
    expect(whole.stills).toEqual(manifest.stills)
    // The hero design's rear view is in the rest alone; its hero stills stay.
    expect(bakedStill(design, 'rear', 'wide', whole, 'v1')!.url).toBe(
      at('rear-wide-2400.cccc3333.webp'),
    )
    expect(bakedStill(design, 'front-left', 'tall', whole, 'v1')!.url).toBe(
      at('front-left-tall-1920.bbbb2222.webp'),
    )
  })

  /** Runs the preload script on a page opened with this fragment and draft, at this width. */
  const preload = (
    script: string,
    { hash = '', draft = null as string | null, tall = false, storage = true } = {},
  ) => {
    const links: Record<string, string>[] = []
    const link = () => {
      const attributes: Record<string, string> = {}
      return {
        set rel(value: string) {
          attributes.rel = value
        },
        set as(value: string) {
          attributes.as = value
        },
        setAttribute: (name: string, value: string) => (attributes[name] = value),
        attributes,
      }
    }
    const page = {
      location: { hash },
      localStorage: {
        getItem: (key: string) => {
          if (!storage) throw new Error('blocked')
          return key === 'fury-draft-v1' ? draft : null
        },
      },
      matchMedia: vi.fn((query: string) => ({ matches: query === TALL_MEDIA && tall })),
      document: {
        createElement: link,
        head: { appendChild: (made: ReturnType<typeof link>) => links.push(made.attributes) },
      },
    }
    new Function(...Object.keys(page), script)(...Object.values(page))
    return links
  }

  it("preloads the hero still for a visit that shows it, with the stage's srcset and sizes", () => {
    const script = heroPreloadScript(manifest, 'v1')!
    const [wide] = preload(script)
    expect(wide).toEqual({
      rel: 'preload',
      as: 'image',
      fetchpriority: 'high',
      imagesrcset: bakedStill(design, 'front-left', 'wide', manifest, 'v1')!.srcset,
      imagesizes: STILL_SIZES.wide,
    })
    const [tall] = preload(script, { tall: true })
    expect(tall.imagesrcset).toBe(bakedStill(design, 'front-left', 'tall', manifest, 'v1')!.srcset)
    expect(tall.imagesizes).toBe(STILL_SIZES.tall)
    // A share link or a draft of the default design shows it too; storage that throws is none.
    const encoded = encodeConfig(DEFAULT_CONFIG)
    expect(preload(script, { hash: `#c=${encoded}` })).toHaveLength(1)
    expect(preload(script, { draft: encoded })).toHaveLength(1)
    expect(preload(script, { storage: false })).toHaveLength(1)
    // Another design, by link or draft: nothing the visit will not show is downloaded.
    expect(preload(script, { hash: '#c=another' })).toEqual([])
    expect(preload(script, { draft: 'another' })).toEqual([])
    expect(preload(script, { hash: `#c=another`, draft: encoded })).toEqual([])
  })

  it('preloads nothing for another version, nothing baked, or no hero', () => {
    expect(heroPreloadScript(manifest, 'v2')).toBeNull()
    expect(heroPreloadScript(EMPTY_MANIFEST, '')).toBeNull()
    expect(heroPreloadScript({ ...manifest, hero: undefined }, 'v1')).toBeNull()
    expect(heroPreloadScript({ ...manifest, stills: {} }, 'v1')).toBeNull()
  })

  it('warns of a manifest the app would ignore, or of quick bakes', () => {
    expect(manifestProblems(EMPTY_MANIFEST, 'v1')).toEqual([])
    expect(manifestProblems(manifest, 'v2')[0]).toMatch(
      /4 stills baked by renderer v1.*renderer v2/,
    )
    expect(manifestProblems(manifest, 'v1')[0]).toMatch(/1 quick-baked stills/)
    const full = { ...manifest, stills: { [design]: manifest.stills[design] } }
    expect(manifestProblems(full, 'v1')).toEqual([])
  })
})
