import type { FixtureId, ReferenceId } from './fixtures'

export type CoverageRow = {
  reference: ReferenceId
  feature: string
  userPath: string
  storedFields: string[]
  baseline: string
  gap: string
  planImpact: string
  states3d: string
  exportWording: string
  sourceClass: 'reference-backed concept' | 'illustrative assumption'
  owner: string
  acceptance: string[]
  fixture: FixtureId
  status: 'partial-code-only' | 'missing-at-base'
}

export const PRODUCT_FACTS = [
  {
    family: 'container',
    source: 'https://www.furycogyms.com/gym-design/container',
    nominalFeet: { lengths: [20, 40], width: 8, height: 9.5 },
    startingUSD: 20000,
    configuredTotal: null,
  },
  {
    family: 'studio',
    source: 'https://www.furycogyms.com/gym-design/studio',
    nominalFeet: { lengths: [20, 40], width: 8, height: 10 },
    startingUSD: 35000,
    configuredTotal: null,
  },
] as const

export const COVERAGE_LEDGER: readonly CoverageRow[] = [
  {
    reference: 'R01',
    feature: 'Rounded dark Studio + readable framed glazing',
    userPath: 'Architecture → Studio / 20 ft / Obsidian; finish is illustrative',
    storedFields: ['family', 'length', 'finish'],
    baseline:
      'studioShell / studioGlazing use rounded ring and frame geometry; rendering not reviewed.',
    gap: 'Check continuous silhouette, outer-skin / reveal / gasket / glass depth order.',
    planImpact: '20×8 ft exterior remains distinct from usable interior.',
    states3d: 'Oblique, interior, warm evening through glass.',
    exportWording: 'S-Series reference unit. Finish and construction geometry illustrative.',
    sourceClass: 'reference-backed concept',
    owner: 'G / A / R',
    acceptance: ['REF-01', 'DETAIL-01', 'DETAIL-04'],
    fixture: 'VF01',
    status: 'partial-code-only',
  },
  {
    reference: 'R01',
    feature: 'Separate ground deck, rooftop platform, rail and left stair',
    userPath: 'Additions → Front deck / Rooftop deck / Exterior staircase',
    storedFields: ['addons.deck', 'addons.roof', 'addons.stairs'],
    baseline: 'Studio add-on booleans and deck/roofDeck/stairs builders exist; not rendered here.',
    gap: 'Show distinct elevations, stair endpoint/landing and rail continuity; railing follows roof concept, not a new priced SKU.',
    planImpact: 'Ground footprint + separately elevated roof/access envelopes from C-SPACE.',
    states3d:
      'Add/remove each; ground deck must not become roof deck; left-side access matches R01.',
    exportWording:
      'Studio outdoor additions: reference-backed layout; dimensions, attachment and engineering by inquiry.',
    sourceClass: 'reference-backed concept',
    owner: 'D / G / I / P',
    acceptance: ['REF-03', 'SPACE-04', 'DETAIL-05'],
    fixture: 'VF01',
    status: 'partial-code-only',
  },
  {
    reference: 'R02',
    feature: 'Pale Studio strength room',
    userPath: 'Studio → Chalk → Strength equipment',
    storedFields: ['family', 'finish', 'items'],
    baseline: 'Chalk, rack, bench, weights and bike exist in catalog/procedural geometry.',
    gap: 'Layer rounded face/reveal, inset glass; show connected rack holes/bar collars, bench supports and fan/crank silhouette without inferring brands.',
    planImpact:
      'Use generated occupied envelope including rack-bar protrusions, not only catalog base rectangle.',
    states3d: 'Day exterior, inside, rack rear; preserve pale edge detail.',
    exportWording:
      'Light Studio gym concept with generic equipment; not manufacturer CAD or certified clearances.',
    sourceClass: 'reference-backed concept',
    owner: 'G / A / R',
    acceptance: ['REF-01', 'DETAIL-01', 'DETAIL-02'],
    fixture: 'VF02',
    status: 'partial-code-only',
  },
  {
    reference: 'R03',
    feature: 'Long Studio, repeated glazing bays and equipment rhythm',
    userPath: 'Studio → 40 ft → mixed gym layout → Desert/campus-like presentation',
    storedFields: ['length', 'items', 'environment'],
    baseline:
      '40-foot Studio and procedural bays exist; desert is an approximation, not the photographed campus.',
    gap: 'Do not stretch corner radius or equipment. Review repeated bays, junctions, longitudinal grain and useful negative space.',
    planImpact: '40×8 ft exterior, unchanged equipment dimensions; interior occupied envelopes.',
    states3d: 'Long oblique and interior sight line; near-black paint retains highlight rolloff.',
    exportWording:
      '40-foot nominal Studio reference; illustrative equipment and campus-like site context, not bundled scope.',
    sourceClass: 'reference-backed concept',
    owner: 'G / A / R',
    acceptance: ['REF-01', 'DETAIL-03', 'DETAIL-05'],
    fixture: 'VF03',
    status: 'partial-code-only',
  },
  {
    reference: 'R04',
    feature: 'Sectional glazed Container opening and projecting header',
    userPath: 'Container → Opening concept → Sectional glazed → pose Open/Closed',
    storedFields: ['openingConcept', 'presentation.openingPose', 'finish'],
    baseline: 'Existing roll-up/center/partial/full choices do not encode this concept.',
    gap: 'Add horizontal framed transparent panels, header/soffit thickness and retained corner structure; no capsule trim.',
    planImpact: 'Opening envelope and overhead endpoint projection separate from usable room.',
    states3d:
      'Closed glazed divisions / open overhead endpoint; pose does not change priced scope.',
    exportWording:
      'Sectional-style glazed opening concept inspired by R04; mechanism and structural design unverified.',
    sourceClass: 'reference-backed concept',
    owner: 'D / G / I / P',
    acceptance: ['REF-02', 'REF-06', 'DETAIL-01', 'DETAIL-04'],
    fixture: 'VF04',
    status: 'missing-at-base',
  },
  {
    reference: 'R05',
    feature: 'Raised glazed panel, supports, roof ribs and front timber deck',
    userPath: 'Container → Raised glazed → Open/Closed; Front deck',
    storedFields: ['openingConcept', 'presentation.openingPose', 'addons.deck'],
    baseline: 'No raised-glazed concept; schema rejects Container additions.',
    gap: 'Keep roof rib/corner structure; panel has finite frame depth, glass inset and connected side supports; deck is not interior floor.',
    planImpact:
      'Track external panel/deck geometry separately; endpoint envelopes are illustrative, not swept certified clearances.',
    states3d: 'Elevated open frame exposes interior / same frame closes without clipping.',
    exportWording:
      'Raised glazing and Container deck are reference concepts; support/actuation details illustrative, subject to inquiry.',
    sourceClass: 'reference-backed concept',
    owner: 'D / G / I / P',
    acceptance: ['REF-02', 'REF-03', 'DETAIL-01'],
    fixture: 'VF05',
    status: 'missing-at-base',
  },
  {
    reference: 'R05',
    feature: 'Pilates / movement room',
    userPath: 'Equipment → Movement mat / Pilates reformer',
    storedFields: ['items'],
    baseline: 'Mat and reformer SKUs/builders exist.',
    gap: 'Reformer must show carriage on rails, shoulder rests, footbar and anchored spring/cable routing; no stretched bench substitute.',
    planImpact: 'Actual reformer footprint and protrusions; working-space guidance not certified.',
    states3d: 'Front, rear and oblique geometry at floor contact.',
    exportWording:
      'Generic Pilates/movement equipment concept; specifications and use clearance by supplier inquiry.',
    sourceClass: 'reference-backed concept',
    owner: 'G / D / I',
    acceptance: ['REF-04', 'DETAIL-02'],
    fixture: 'VF05',
    status: 'partial-code-only',
  },
  {
    reference: 'R06',
    feature: 'Sauna enclosure and metal-clad recovery basin in pale Studio',
    userPath: 'Studio → Chalk → Recovery → Sauna / Cold plunge',
    storedFields: ['family', 'finish', 'items', 'flooring'],
    baseline: 'Sauna and plunge SKUs exist; generic dimensions are illustrative.',
    gap: 'Sauna vertical boards and horizontal bench remain distinct; finite door/lining thickness and plunge rim/water cavity/drain rather than solid block.',
    planImpact:
      'Generated occupied enclosure + basin footprint; do not invent wet/heat/electrical clearance or capability.',
    states3d: 'Day/evening exterior and rear/inside detail.',
    exportWording:
      'Illustrative recovery layout with generic sauna/plunge; installation, drainage, electrical and heat requirements unverified.',
    sourceClass: 'reference-backed concept',
    owner: 'G / A / D / I',
    acceptance: ['REF-04', 'DETAIL-02', 'DETAIL-05'],
    fixture: 'VF06',
    status: 'partial-code-only',
  },
  {
    reference: 'R07',
    feature: 'Open-front Container plus roof deck, rails and right stair',
    userPath: 'Container → Open front → Rooftop deck / Exterior staircase',
    storedFields: ['openingConcept', 'presentation.openingPose', 'addons.roof', 'addons.stairs'],
    baseline: 'Full-width opening is not roof/access support; schema rejects Container additions.',
    gap: 'Retain header/corner posts; right stair top tread meets separate Container platform, opening in rail aligns landing. Do not transfer Studio height/attachments.',
    planImpact: '9.5-foot nominal Container and independent elevated access envelopes.',
    states3d:
      'Broad open front, rooftop level, stair connection; no invented closure mechanism for open-front.',
    exportWording:
      'Container rooftop/access concept traced to R07; engineering and load capacity by inquiry.',
    sourceClass: 'reference-backed concept',
    owner: 'D / G / I / P',
    acceptance: ['REF-02', 'REF-03', 'DETAIL-01', 'DETAIL-05'],
    fixture: 'VF07',
    status: 'missing-at-base',
  },
  {
    reference: 'R08',
    feature: 'Custom indoor/outdoor architectural wellness inquiry',
    userPath: 'Custom wellness inquiry → illustrative context → project brief / Fury inquiry link',
    storedFields: ['presentation.context'],
    baseline: 'No custom-wellness context field or explicit route at base.',
    gap: 'Bounded steel-frame/timber-soffit threshold context, not whole-house model or third standard product. Ensure route is visible beyond fixture.',
    planImpact:
      'Reference unit footprint only; site/custom architecture excluded from product collision, count and quote.',
    states3d:
      'Illustrative deep soffit, threshold, warm source and adjacent recovery scale cue; no engineered house claim.',
    exportWording:
      'Custom architectural wellness inquiry inspired by R08. Reference unit is a scale aid; surrounding architecture excluded from standard unit scope.',
    sourceClass: 'reference-backed concept',
    owner: 'D / G / I / P',
    acceptance: ['REF-05', 'REF-06', 'REF-07'],
    fixture: 'VF08',
    status: 'missing-at-base',
  },
  {
    reference: 'R09',
    feature: 'Hinged corrugated solid leaves, hinges and locking rods',
    userPath: 'Container → Hinged solid → Open/Closed',
    storedFields: ['openingConcept', 'presentation.openingPose'],
    baseline: 'No hinged-solid field or pose at base.',
    gap: 'Actual leaf thickness, corrugation and perimeter rails; pins connect hinge barrels, rods run through guide brackets to latch handles. Do not turn leaves into glazed sectional panels.',
    planImpact:
      'Opening/leaf endpoints external to interior; show physical leaf projection in plan, separate from engineering clearance.',
    states3d:
      'Open leaf faces/backs + closed seams/locking hardware; recessed sill and connected floor buildup.',
    exportWording:
      'Solid hinged opening concept inspired by R09; illustrated hardware and motion endpoints not engineered specifications.',
    sourceClass: 'reference-backed concept',
    owner: 'D / G / I / P',
    acceptance: ['REF-02', 'DETAIL-01', 'DETAIL-02'],
    fixture: 'VF09',
    status: 'missing-at-base',
  },
  {
    reference: 'R09',
    feature: 'Sunken lounge / fire feature in front of unit',
    userPath: 'Presentation context → Sunken lounge',
    storedFields: ['presentation.context'],
    baseline: 'Existing courtyard/desert/studio does not encode lounge context.',
    gap: 'Keep grade change/lounge outside product geometry and all equipment totals; no gas/fire installation promise.',
    planImpact: 'Site-context overlay only, not product occupied envelope or quoted platform.',
    states3d:
      'Show/hide context independently of hinged opening; preserve camera readability of sill and door leaves.',
    exportWording:
      'Sunken lounge shown as illustrative site context only; excluded from unit scope, configured total and engineering.',
    sourceClass: 'illustrative assumption',
    owner: 'D / A / I / P',
    acceptance: ['REF-05', 'REF-06', 'REF-07', 'DETAIL-05'],
    fixture: 'VF09',
    status: 'missing-at-base',
  },
]

export const VISUAL_RUBRIC = {
  scores: [
    '0 — missing/broken',
    '1 — obvious placeholder',
    '2 — recognizable but conspicuously synthetic',
    '3 — convincing with limited non-dominant defects',
    '4 — exceptional at required viewing scale',
  ],
  dimensions: [
    'family/silhouette',
    'construction detail',
    'equipment realism',
    'material response',
    'glazing/reflections',
    'light/contact',
    'composition/context',
    'spatial sharpness',
    'temporal stability',
  ],
  premium: {
    status: 'NOT REVIEWED',
    scores: null,
    gate: 'Every dimension >=3; designated hero/detail silhouette, construction, equipment, materials and sharpness =4; human approval still required.',
  },
  lite: {
    status: 'NOT REVIEWED',
    scores: null,
    gate: 'Score separately 0–4: preserve silhouette, material identity, interior readability, contact and edges. Compatibility evidence is not premium approval.',
  },
  rejections: [
    'Generic-box Studio',
    'Toy equipment',
    'Faceted hero curves',
    'Glass hides interior',
    'Wrong mirror environment',
    'Disconnected/floating stair',
    'Clipped doors/equipment',
    'Texture blur',
    'Crushed/clipped finish',
    'No use-space',
    'Distracting temporal shimmer',
    'Upscaled low-resolution export',
  ],
  motion:
    'Separate sustained orbit/interior/tier-transition recording; no still frame certifies temporal stability.',
  pilots:
    'ART-04 NOT REVIEWED: no licensed GLB or KTX2 comparison run; no adoption or measured benefit claimed.',
} as const
