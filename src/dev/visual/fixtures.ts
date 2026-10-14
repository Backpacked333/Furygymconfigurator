import type { Config, PlacedItem, View } from '../../lib/config'
import type { Backend, Quality } from '../../render/quality'

export const FIXTURE_VERSION = 'fury-vf-1'
export const BASE_REVISION = '15f36b81ebb79ae5a0a475f41849a7900fa1d7e9'
export type FixtureId =
  `VF${'01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11' | '12'}`
export type ReferenceId = `R${'01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09'}`
export type Vector3Tuple = [number, number, number]
export type FixtureBaseConfig = Pick<
  Config,
  | 'family'
  | 'containerOpening'
  | 'integratedFinish'
  | 'studioLayout'
  | 'length'
  | 'finish'
  | 'accent'
  | 'addons'
  | 'flooring'
  | 'mirror'
  | 'package'
  | 'items'
  | 'environment'
  | 'time'
  | 'lights'
> & { v: 2 }
export type OpeningConcept =
  'standard' | 'sectional-glazed' | 'raised-glazed' | 'open-front' | 'hinged-solid'
export type Presentation = {
  openingPose: 'open' | 'closed'
  context: 'product' | 'custom-wellness' | 'sunken-lounge'
}

/** Recipes are not validated Config documents. D's v3 parser owns acceptance. */
export type ConceptOverrides = {
  openingConcept: OpeningConcept
  presentation: Presentation
  addons?: Config['addons']
}
export type FixtureRecipe = { base: FixtureBaseConfig; concepts: ConceptOverrides }
export type FixtureCandidate = Omit<FixtureBaseConfig, 'v'> & ConceptOverrides & { v: 3 }
export type CameraRecipe = {
  position: Vector3Tuple
  target: Vector3Tuple
  fov: number
  near: number
  far: number
}
export type Crop = {
  label: string
  /** Pixels in the 1920×1080 reference buffer, never CSS coordinates. */
  rect: [number, number, number, number]
  inspectAt: '100%'
}
export type Shot = {
  id: string
  view: View | 'neutral-stage'
  camera: CameraRecipe
  time: number
  exposure: number
  baseOverrides?: Partial<
    Pick<Config, 'finish' | 'mirror' | 'environment' | 'items' | 'length' | 'family' | 'flooring'>
  >
  conceptOverrides?: Partial<ConceptOverrides>
  crops: Crop[]
  checks: string[]
}
export type VisualFixture = {
  id: FixtureId
  references: ReferenceId[]
  story: string
  recipe: FixtureRecipe
  shots: Shot[]
  acceptance: string[]
  geometryStatus: 'candidate-not-rendered'
  assetVersion: string
  readiness: typeof READINESS
}

export const READINESS = {
  required: 'settled',
  activeMaps: 'ready',
  match: ['committedRevision', 'rendererGeneration', 'materialGeneration', 'cameraToken'],
  degradedPolicy:
    'Record missing maps and effective tier; never score a degraded frame as premium.',
  actualMeasurements:
    'Record CSS canvas, drawing buffer, effective render scale, backend, GPU/driver and encoded size.',
} as const

export const CAPTURE_PROFILES: readonly {
  id: string
  css: [number, number]
  dpr: number
  /** Required actual scene-render buffer, including offscreen presentation capture. */
  expectedBuffer: [number, number]
  tier: Quality
  backend: Backend
  output: [number, number]
  mode: 'settled' | 'presentation'
}[] = [
  {
    id: 'premium-webgpu',
    css: [1920, 1080],
    dpr: 1,
    expectedBuffer: [1920, 1080],
    tier: 'ultra',
    backend: 'webgpu',
    output: [1920, 1080],
    mode: 'settled',
  },
  {
    id: 'premium-webgl2',
    css: [1920, 1080],
    dpr: 1,
    expectedBuffer: [1920, 1080],
    tier: 'ultra',
    backend: 'webgl2',
    output: [1920, 1080],
    mode: 'settled',
  },
  {
    id: 'lite-webgl2',
    css: [1920, 1080],
    dpr: 1,
    expectedBuffer: [1920, 1080],
    tier: 'lite',
    backend: 'webgl2',
    output: [1920, 1080],
    mode: 'settled',
  },
  {
    id: 'laptop-dpr1',
    css: [1440, 900],
    dpr: 1,
    expectedBuffer: [1440, 900],
    tier: 'high',
    backend: 'webgpu',
    output: [1440, 900],
    mode: 'settled',
  },
  {
    id: 'laptop-dpr2',
    css: [1440, 900],
    dpr: 2,
    expectedBuffer: [2880, 1800],
    tier: 'ultra',
    backend: 'webgpu',
    output: [2880, 1800],
    mode: 'settled',
  },
  {
    id: 'presentation-native-4k',
    css: [1920, 1080],
    dpr: 1,
    expectedBuffer: [3840, 2160],
    tier: 'ultra',
    backend: 'webgpu',
    output: [3840, 2160],
    mode: 'presentation',
  },
]

const noAddons: Config['addons'] = { deck: false, roof: false, stairs: false, gazebo: false }
const item = (sku: PlacedItem['sku'], x: number, z = 0, rotation: 0 | 90 = 0): PlacedItem => ({
  id: `vf-${sku}-${x}-${z}-${rotation}`,
  sku,
  x,
  z,
  rotation,
})
const strength = [item('rack', -5, -0.5), item('bench', 1, 0), item('weights', 6, -1.9)]
const recovery = [item('sauna', -5.2, -0.7), item('plunge', 3.5, -0.3, 90)]
const movement = [item('mat', -4.5, -0.2), item('reformer', 3.8, 0)]

function recipe(
  base: Partial<FixtureBaseConfig> = {},
  concepts: Partial<ConceptOverrides> = {},
): FixtureRecipe {
  return {
    base: {
      v: 2,
      family: 'studio',
      containerOpening: 'roll-up',
      integratedFinish: false,
      studioLayout: 'single',
      length: 20,
      finish: 'obsidian',
      accent: false,
      addons: { ...noAddons },
      flooring: 'rubber',
      mirror: false,
      package: 'custom',
      items: strength.map((i) => ({ ...i })),
      environment: 'courtyard',
      time: 16.5,
      lights: true,
      ...base,
    },
    concepts: {
      openingConcept: 'standard',
      presentation: { openingPose: 'closed', context: 'product' },
      ...concepts,
    },
  }
}

function shot(
  id: string,
  position: Vector3Tuple,
  target: Vector3Tuple,
  options: Partial<Omit<Shot, 'id' | 'camera'>> & { fov?: number } = {},
): Shot {
  const { fov = 38, ...rest } = options
  return {
    id,
    view: 'exterior',
    camera: { position, target, fov, near: 0.05, far: 250 },
    time: 16.5,
    exposure: 1,
    crops: [
      { label: 'Assembly / edge highlight', rect: [280, 200, 480, 400], inspectAt: '100%' },
      { label: 'Interior / floor contact', rect: [860, 570, 640, 360], inspectAt: '100%' },
    ],
    checks: ['No geometry clipping', 'No unready maps', 'Read actual interior through glass'],
    ...rest,
  }
}

function fixture(
  id: FixtureId,
  references: ReferenceId[],
  story: string,
  config: FixtureRecipe,
  shots: Shot[],
  acceptance: string[],
): VisualFixture {
  return {
    id,
    references,
    story,
    recipe: config,
    shots,
    acceptance,
    geometryStatus: 'candidate-not-rendered',
    assetVersion: `git:${BASE_REVISION}`,
    readiness: READINESS,
  }
}

export const VISUAL_FIXTURES: readonly VisualFixture[] = [
  fixture(
    'VF01',
    ['R01'],
    'Dark Studio: distinguish front timber landing from elevated roof platform; left stair meets its landing; warm interior remains readable.',
    recipe({
      flooring: 'oak',
      time: 19,
      addons: { ...noAddons, deck: true, roof: true, stairs: true },
      items: [
        item('bike', -6),
        item('weights', -1.8, -1.8),
        item('treadmill', 3.5),
        item('bench', 7, 0),
      ],
    }),
    [
      shot('roof-ground-evening', [-27, 17, 39], [0, 6.2, 0], { time: 19 }),
      shot('roof-landing', [-19, 17, 17], [-8, 9.5, 0], { time: 19, fov: 36 }),
    ],
    ['REF-01', 'REF-03', 'DETAIL-05', 'ART-01', 'ART-03'],
  ),
  fixture(
    'VF02',
    ['R02'],
    'Pale Studio strength: thick continuous corner, nested reveal, dark recessed frames and full-size rack with supported plates.',
    recipe({
      finish: 'chalk',
      items: [item('bench', -6), item('rack', -0.5, -0.5), item('bike', 6)],
    }),
    [
      shot('strength-day', [26, 11, 39], [0, 4.9, 0]),
      shot('strength-interior', [8.4, 5.3, 2.5], [-2, 4, -1], { view: 'interior', fov: 62 }),
    ],
    ['REF-01', 'DETAIL-01', 'DETAIL-02', 'DETAIL-04', 'ART-01'],
  ),
  fixture(
    'VF03',
    ['R03'],
    '40-foot dark Studio: keep eight-foot exterior depth and coherent long glazing bay/equipment rhythm, not a uniformly stretched 20-foot asset.',
    recipe({
      length: 40,
      environment: 'desert',
      flooring: 'oak',
      items: [
        item('rack', -13, -0.5),
        item('weights', -6, -1.8),
        item('bench', 1),
        item('mat', 8),
        item('bike', 14),
      ],
    }),
    [
      shot('long-oblique', [-39, 15, 58], [0, 4.8, 0], { fov: 40 }),
      shot('long-interior', [17, 5.4, 2], [-6, 3.6, -0.4], { view: 'interior', fov: 62 }),
    ],
    ['REF-01', 'DETAIL-03', 'DETAIL-05', 'ART-01'],
  ),
  fixture(
    'VF04',
    ['R04'],
    'Bronze Container: corrugated shell and corner blocks, framed sectional glazing under a projecting header; not solid cargo leaves.',
    recipe(
      { family: 'container', finish: 'bronze', integratedFinish: true, flooring: 'stone' },
      { openingConcept: 'sectional-glazed' },
    ),
    [
      shot('sectional-closed', [-27, 13, 39], [0, 4.7, 0], { time: 18 }),
      shot('sectional-open', [-27, 13, 39], [0, 4.7, 0], {
        time: 18,
        conceptOverrides: { presentation: { openingPose: 'open', context: 'product' } },
      }),
    ],
    ['REF-02', 'DETAIL-01', 'DETAIL-04', 'ART-01'],
  ),
  fixture(
    'VF05',
    ['R05'],
    'Raised framed glass over a Pilates room: show roof ribs, side support endpoints, open/closed glazing and separate timber threshold.',
    recipe(
      { family: 'container', integratedFinish: true, flooring: 'stone', items: movement },
      {
        openingConcept: 'raised-glazed',
        presentation: { openingPose: 'open', context: 'product' },
        addons: { ...noAddons, deck: true },
      },
    ),
    [
      shot('pilates-raised', [-26, 32, 35], [0, 4, 0], { fov: 40 }),
      shot('pilates-closed', [-26, 32, 35], [0, 4, 0], {
        fov: 40,
        conceptOverrides: { presentation: { openingPose: 'closed', context: 'product' } },
      }),
    ],
    ['REF-02', 'REF-04', 'DETAIL-01', 'DETAIL-02', 'ART-01'],
  ),
  fixture(
    'VF06',
    ['R06'],
    'Pale recovery Studio: timber-lined sauna enclosure with door/bench and metal plunge rim/basin; never a relabeled strength room.',
    recipe({ finish: 'chalk', flooring: 'stone', items: recovery }),
    [
      shot('wellness-day', [27, 12, 39], [0, 4.7, 0]),
      shot('wellness-evening', [27, 12, 39], [0, 4.7, 0], { time: 20 }),
    ],
    ['REF-04', 'DETAIL-02', 'DETAIL-05', 'ART-01'],
  ),
  fixture(
    'VF07',
    ['R07'],
    'Container open front beneath roof deck: right-hand stair, separate elevated landing and continuous railing terminate into the platform.',
    recipe(
      {
        family: 'container',
        containerOpening: 'full',
        integratedFinish: true,
        items: [item('bike', -6), item('rack', -0.5, -0.5), item('weights', 6, -1.8)],
      },
      {
        openingConcept: 'open-front',
        presentation: { openingPose: 'open', context: 'product' },
        addons: { ...noAddons, roof: true, stairs: true },
      },
    ),
    [
      shot('roof-open-front', [29, 18, 41], [0, 6.7, 0]),
      shot('stair-landing', [23, 15, 18], [9, 9, 0], { fov: 35 }),
    ],
    ['REF-02', 'REF-03', 'DETAIL-01', 'DETAIL-05', 'ART-01'],
  ),
  fixture(
    'VF08',
    ['R08'],
    'Custom inquiry only: bounded indoor/outdoor wellness context; standard reference unit is a scale aid, never a third family or an engineered house.',
    recipe(
      { flooring: 'oak', time: 19.5 },
      { presentation: { openingPose: 'open', context: 'custom-wellness' } },
    ),
    [
      shot('custom-inquiry', [26, 13, 38], [0, 4.8, 0], {
        time: 19.5,
        checks: [
          'Custom inquiry label visible',
          'Context excluded from quote, equipment count and product envelope',
          'Soffit grain and strip-light source agree',
        ],
      }),
    ],
    ['REF-05', 'REF-07', 'DETAIL-05', 'ART-01'],
  ),
  fixture(
    'VF09',
    ['R09'],
    'Dark Container solid hinged leaves: corrugation, hinges, locking rods and recessed threshold; sunken lounge remains excluded site context.',
    recipe(
      {
        family: 'container',
        containerOpening: 'full',
        integratedFinish: true,
        mirror: true,
        items: strength,
      },
      {
        openingConcept: 'hinged-solid',
        presentation: { openingPose: 'open', context: 'sunken-lounge' },
      },
    ),
    [
      shot('hinged-open', [-30, 14, 42], [0, 4.6, 1]),
      shot('hinged-closed', [-30, 14, 42], [0, 4.6, 1], {
        conceptOverrides: { presentation: { openingPose: 'closed', context: 'sunken-lounge' } },
      }),
    ],
    ['REF-02', 'REF-05', 'REF-07', 'DETAIL-01', 'ART-01'],
  ),
  fixture(
    'VF10',
    ['R01', 'R02', 'R04', 'R09'],
    'Construction: review full silhouettes before corners, glazing gaskets, threshold thickness, corrugation/header and hinge/rod connections at native pixels.',
    recipe({ items: [], package: 'empty', environment: 'studio' }),
    [
      ...(['chalk', 'obsidian'] as const).map((finish) =>
        shot(`studio-${finish}`, [-14, 9.7, 12], [-8.5, 8.5, 3.8], {
          fov: 32,
          baseOverrides: { finish },
        }),
      ),
      shot('studio-threshold', [-11, 2.8, 10], [-8, 1, 3.8], { fov: 30 }),
      ...(['chalk', 'obsidian'] as const).map((finish) =>
        shot(`container-hardware-${finish}`, [-16, 9, 14], [-9.5, 7, 3.8], {
          fov: 34,
          baseOverrides: { family: 'container', finish },
          conceptOverrides: {
            openingConcept: 'hinged-solid',
            presentation: { openingPose: 'open', context: 'product' },
          },
        }),
      ),
      shot('container-header', [12, 12, 13], [6.5, 8.8, 3.8], {
        fov: 34,
        baseOverrides: { family: 'container', finish: 'bronze' },
        conceptOverrides: { openingConcept: 'sectional-glazed' },
      }),
    ],
    ['DETAIL-01', 'DETAIL-03', 'ART-01', 'ART-02', 'RES-03'],
  ),
  fixture(
    'VF11',
    ['R02', 'R03', 'R06', 'R09'],
    'Separate material calibration from preference: 18% gray, one-foot checker, dielectric/metal, floor/wall, glass at grazing incidence and indoor mirror subject.',
    recipe({ mirror: true, flooring: 'oak', environment: 'studio' }),
    [
      shot('neutral-day', [10, 7, 14], [0, 2, 0], { view: 'neutral-stage', time: 12, fov: 42 }),
      shot('neutral-warm', [10, 7, 14], [0, 2, 0], { view: 'neutral-stage', time: 20, fov: 42 }),
      shot('glass-grazing-day', [21, 6.5, 7], [0, 4.6, 3.8], { time: 12, fov: 42 }),
      shot('glass-grazing-evening', [21, 6.5, 7], [0, 4.6, 3.8], { time: 20, fov: 42 }),
      shot('mirror-metal-interior', [8.5, 5, 2.5], [-2, 4, -3.4], { view: 'interior', fov: 64 }),
      shot('mirror-metal-evening', [8.5, 5, 2.5], [-2, 4, -3.4], {
        view: 'interior',
        time: 20,
        fov: 64,
      }),
    ],
    ['ART-02', 'DETAIL-03', 'DETAIL-04', 'DETAIL-05', 'RES-03'],
  ),
  fixture(
    'VF12',
    ['R02', 'R05', 'R06', 'R09'],
    'Equipment: inspect connected rack/weights, bench pad/support/adjustment, reformer carriage/rails and distinct sauna/plunge geometry from front, rear and oblique.',
    recipe({ environment: 'studio', mirror: true }),
    [
      shot('rack-front', [-5, 4, 3.2], [-5, 3.8, -0.5], { view: 'interior', fov: 66 }),
      shot('rack-rear-oblique', [-8.8, 5, -3.2], [-5, 3.8, -0.5], { view: 'interior', fov: 68 }),
      shot('bench-floor-contact', [4, 2.4, 3.2], [1, 1.6, 0], { view: 'interior', fov: 56 }),
      shot('dumbbells-rear', [8.4, 3.5, -3.1], [6, 2.6, -1.8], { view: 'interior', fov: 68 }),
      shot('reformer-oblique', [8.5, 4.6, 3.2], [3.8, 1.9, 0], {
        view: 'interior',
        fov: 62,
        baseOverrides: { items: movement },
      }),
      shot('reformer-rear', [0.5, 3.8, -3.2], [3.8, 1.9, 0], {
        view: 'interior',
        fov: 64,
        baseOverrides: { items: movement },
      }),
      shot('sauna-plunge-front', [8, 5.4, 3.2], [-2.5, 3.8, -0.5], {
        view: 'interior',
        fov: 68,
        baseOverrides: { items: recovery, flooring: 'stone' },
      }),
      shot('sauna-plunge-rear', [7.7, 4.7, -3.1], [-3, 3.8, 0], {
        view: 'interior',
        fov: 68,
        baseOverrides: { items: recovery, flooring: 'stone' },
      }),
      shot('cardio-oblique', [5, 4.8, 3.1], [0, 2.5, 0], {
        view: 'interior',
        fov: 64,
        baseOverrides: { items: [item('bike', -4), item('treadmill', 1.5)] },
      }),
    ],
    ['DETAIL-02', 'DETAIL-05', 'ART-01', 'RES-03'],
  ),
]

/** Fresh copies prevent camera/runner edits from contaminating the next deterministic run. */
export function resolveFixture(id: FixtureId, shotId?: string) {
  const fixture = VISUAL_FIXTURES.find((f) => f.id === id)
  if (!fixture) throw new Error(`Unknown visual fixture: ${id}`)
  const shot = fixture.shots.find((s) => s.id === (shotId ?? fixture.shots[0].id))
  if (!shot) throw new Error(`Unknown shot ${shotId} in ${id}`)
  const base: FixtureBaseConfig = { ...fixture.recipe.base, ...shot.baseOverrides, time: shot.time }
  const concepts = { ...fixture.recipe.concepts, ...shot.conceptOverrides }
  const candidate: FixtureCandidate = { ...base, ...concepts, v: 3 }
  return structuredClone({
    fixtureId: id,
    fixtureVersion: FIXTURE_VERSION,
    baseConfig: base,
    candidate,
    shot,
    assetVersion: fixture.assetVersion,
    readiness: fixture.readiness,
  })
}

export async function fixtureHash(id: FixtureId, shotId?: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(resolveFixture(id, shotId)))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Only same-aspect outputs can reuse pixel crops. 16:10 needs a newly framed shot. */
export function cropForOutput(crop: Crop, width: number, height: number): Crop {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * 9 !== height * 16
  )
    throw new Error('Crop scaling requires a positive integer 16:9 native output')
  return { ...crop, rect: crop.rect.map((n) => Math.round((n * width) / 1920)) as Crop['rect'] }
}
