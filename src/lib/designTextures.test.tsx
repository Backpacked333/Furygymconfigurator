// @vitest-environment jsdom
import { createElement, Fragment } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultDesign, parseDesign, projectDesignToConfig } from '../domain/design'
import { LOOK_REFS } from '../domain/presentation'
import { CATALOG, DEFAULT_CONFIG, ENVIRONMENTS, configSchema, type Config } from './config'
import { textureSetsFor } from './designTextures'

// What the scene's plants and its window glow need of a running GPU scene and a 2D canvas, which
// jsdom lacks; none of it asks for a scan.
vi.mock('@react-three/fiber', () => ({
  useThree: (select: (state: unknown) => unknown) => select({ invalidate: () => {} }),
  useFrame: () => {},
}))
vi.mock('../render/vegetation', async (actual) => {
  const vegetation = await actual<typeof import('../render/vegetation')>()
  const { MeshStandardNodeMaterial } = await import('three/webgpu')
  const plain = () => new MeshStandardNodeMaterial()
  return {
    ...vegetation,
    leafMaterial: plain,
    grassMaterial: plain,
    palmMaterial: plain,
    blossomMaterial: plain,
  }
})
beforeAll(() => {
  // The studio's signature is painted on a canvas.
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => target[key] ?? (() => ({ addColorStop() {} })),
  })
  HTMLCanvasElement.prototype.getContext = (() => context) as never
})
afterEach(() => vi.unstubAllGlobals())

/**
 * The sets the scene for `config` downloads: its setting (Landscape) and its unit with its
 * equipment (StudioModel), rendered once with a fresh material library, which makes every surface
 * while rendering. The library fetches each map by URL (decoding off the main thread, as in a
 * browser), so this is what the live view would download.
 */
async function scansFor(config: Config) {
  vi.resetModules()
  const urls: string[] = []
  vi.stubGlobal('createImageBitmap', vi.fn())
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url)
      return new Promise(() => {})
    }),
  )
  const { Landscape } = await import('../components/Landscape')
  const { StudioModel } = await import('../components/StudioModel')
  // The scene's elements are not HTML, which React DOM says of each: not the point here.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    renderToString(
      createElement(
        Fragment,
        null,
        createElement(Landscape, { config, quality: 'high' }),
        createElement(StudioModel, { config, quality: 'high' }),
      ),
    )
  } finally {
    error.mockRestore()
  }
  return [...new Set(urls.map((url) => url.split('/textures/')[1].split('/')[0]))].sort()
}

/** A design: the default with `patch`, as the config schema accepts it. */
const row = (name: string, patch: Partial<Config>): [string, Config] => [
  name,
  configSchema.parse({ ...DEFAULT_CONFIG, ...patch }),
]
const studio: Partial<Config> = { family: 'studio', environment: 'studio', items: [] }
const container: Partial<Config> = {
  family: 'container',
  accent: false,
  doorsOpen: true,
  environment: 'studio',
  items: [],
}
const addons = (on: Partial<Config['addons']>) => ({ addons: { ...DEFAULT_CONFIG.addons, ...on } })
const STYLES = ['gallery', 'slatted', 'timber', 'birch'] as const
const FLOORS = ['rubber', 'oak', 'stone', 'concrete'] as const

/**
 * Each option on its own (so one option's sets cannot hide another's omission), on both families
 * where it applies; every setting with each family, size, time and deck that place things in it;
 * and the library's designs.
 */
const matrix: [string, Config][] = [
  ...ENVIRONMENTS.flatMap(({ id: environment }) => [
    row(`${environment}, Studio 20`, { ...studio, environment }),
    row(`${environment}, Container 40 at night`, {
      ...container,
      environment,
      length: 40,
      lights: true,
      time: 20.5,
    }),
    row(`${environment}, deck, no lights`, {
      ...studio,
      environment,
      lights: false,
      ...addons({ deck: true }),
    }),
  ]),
  ...STYLES.flatMap((interiorStyle, i) => [
    row(`${interiorStyle} on ${FLOORS[i]}`, { ...studio, interiorStyle, flooring: FLOORS[i] }),
    row(`Container ${interiorStyle} on ${FLOORS[i]}`, {
      ...container,
      interiorStyle,
      flooring: FLOORS[i],
    }),
  ]),
  ...(['roll-up', 'center', 'partial', 'full'] as const).map((containerOpening) =>
    row(`Container ${containerOpening}`, { ...container, containerOpening }),
  ),
  row('Container infill', {
    ...container,
    containerOpening: 'full',
    openingInfill: 'glass-overhead',
  }),
  row('Container awning', { ...container, containerOpening: 'center', openingInfill: 'awning' }),
  row('Container integrated, closed', { ...container, integratedFinish: true, doorsOpen: false }),
  row('accent', { ...studio, accent: true }),
  row('mirror', { ...studio, mirror: true }),
  row('sliding door', { ...studio, studioDoor: 'sliding' }),
  ...(['deck', 'gazebo', 'roof', 'stairs'] as const).map((addon) =>
    row(addon, { ...studio, ...addons({ [addon]: true }) }),
  ),
  ...(['deck', 'roof', 'stairs', 'canopy'] as const).map((addon) =>
    row(`Container ${addon}`, { ...container, ...addons({ [addon]: true }) }),
  ),
  row('roof, stairs, cable', {
    ...studio,
    railing: 'cable',
    ...addons({ roof: true, stairs: true }),
  }),
  row('Container roof, stairs, cable', {
    ...container,
    railing: 'cable',
    ...addons({ roof: true, stairs: true }),
  }),
  ...CATALOG.map(({ id: sku }) =>
    row(`${sku} alone`, { ...studio, items: [{ id: sku, sku, x: 0, z: 0, rotation: 0 }] }),
  ),
  // Each look on the default Studio, and each fixed arrangement.
  ...LOOK_REFS.map((lookRef): [string, Config] => {
    const base = defaultDesign()
    const presentation = { ...base.presentation, lookRef }
    return [`library ${lookRef}`, projectDesignToConfig(parseDesign({ ...base, presentation }))]
  }),
  ...(['studio', 'container'] as const).flatMap((family) =>
    ([20, 40] as const).map((lengthFt): [string, Config] => [
      `library ${family} ${lengthFt}`,
      projectDesignToConfig(defaultDesign({ family, lengthFt })),
    ]),
  ),
]

describe('the sets a design is made from, read off the design', () => {
  it.each(matrix)('are those its scene downloads: %s', async (_, config) => {
    // Exactly: one missing would be downloaded only once the view is open, and kept waiting on;
    // one too many would be downloaded for nothing, and its bytes kept for the session.
    expect([...textureSetsFor(config)].sort()).toEqual(await scansFor(config))
  })

  it('list each set once, the unit’s first', () => {
    const sets = textureSetsFor(projectDesignToConfig(defaultDesign()))
    expect(new Set(sets).size).toBe(sets.length)
    expect(sets.slice(0, 2)).toEqual(['powder_coat', 'brushed_metal'])
  })
})
