/** Concept-model dimensions in feet, not surveyed dimensions or certified working clearances. */
export type Point3 = { x: number; y: number; z: number }
export type Bounds3 = { min: Point3; max: Point3 }
export type SpatialConfig = {
  family: 'studio' | 'container'
  length: 20 | 40
  containerOpening: 'roll-up' | 'center' | 'partial' | 'full'
  openingConcept?: 'standard' | 'sectional-glazed' | 'raised-glazed' | 'open-front' | 'hinged-solid'
  presentation?: { openingPose?: 'open' | 'closed'; context?: string }
  addons: { deck: boolean; roof: boolean; stairs: boolean; gazebo: boolean }
}
export const FINISHED_FLOOR_Y = 0.96
export const GROUND_DECK_Y = 0.86
export const SPATIAL_VERSION = 1
export const MODEL_HEIGHT = { studio: 10, container: 9.5 } as const

export function bounds3(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): Bounds3 {
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } }
}
export function translateBounds(b: Bounds3, p: Point3): Bounds3 {
  return bounds3(
    b.min.x + p.x,
    b.min.y + p.y,
    b.min.z + p.z,
    b.max.x + p.x,
    b.max.y + p.y,
    b.max.z + p.z,
  )
}
export function intersects(a: Bounds3, b: Bounds3, tolerance = 0.0001) {
  return (['x', 'y', 'z'] as const).every(
    (k) => a.max[k] > b.min[k] + tolerance && a.min[k] < b.max[k] - tolerance,
  )
}
export function containsBounds(outer: Bounds3, inner: Bounds3, tolerance = 0.0001) {
  return (['x', 'y', 'z'] as const).every(
    (k) => inner.min[k] >= outer.min[k] - tolerance && inner.max[k] <= outer.max[k] + tolerance,
  )
}

/** Conservative, outward-rounded generated envelopes. Tests bind these to actual model vertices. */
export const EQUIPMENT_ENVELOPES = {
  rack: bounds3(-3.63, 0, -1.65, 3.63, 7.505, 1.65),
  bench: bounds3(-0.926, 0, -2.186, 0.926, 1.621, 2.08),
  weights: bounds3(-2.051, 0, -0.91, 2.051, 2.832, 0.91),
  bike: bounds3(-0.951, 0, -1.845, 0.951, 4.331, 1.68),
  treadmill: bounds3(-1.351, 0, -2.825, 1.351, 4.55, 2.891),
  sauna: bounds3(-2.451, 0, -2.201, 2.451, 7, 2.221),
  plunge: bounds3(-1.5, 0, -2.651, 1.5, 2.76, 2.651),
  mat: bounds3(-1.076, 0, -2.651, 1.025, 0.49, 2.651),
  reformer: bounds3(-1.17, 0, -3.201, 1.17, 1.72, 3.201),
  lounge: bounds3(-1.126, 0, -2.42, 1.126, 2.616, 2.22),
} as const
export type EquipmentSku = keyof typeof EQUIPMENT_ENVELOPES
export type SpatialItem = { id: string; sku: EquipmentSku; x: number; z: number; rotation: 0 | 90 }
const WORKING_MARGIN: Record<EquipmentSku, number> = {
  rack: 1.5,
  bench: 1,
  weights: 1.5,
  bike: 1,
  treadmill: 2,
  sauna: 1,
  plunge: 1,
  mat: 0.5,
  reformer: 0.5,
  lounge: 0.5,
}

/** Matches Equipment's negative Y rotation: local +X becomes world +Z. */
export function rotateBounds(b: Bounds3, rotation: 0 | 90): Bounds3 {
  return rotation === 0
    ? structuredClone(b)
    : bounds3(-b.max.z, b.min.y, b.min.x, -b.min.z, b.max.y, b.max.x)
}
export function occupiedEnvelope(
  item: SpatialItem,
  worldOffset: Point3 = { x: 0, y: 0, z: 0 },
): Bounds3 {
  return translateBounds(rotateBounds(EQUIPMENT_ENVELOPES[item.sku], item.rotation), {
    x: item.x + worldOffset.x,
    y: FINISHED_FLOOR_Y + worldOffset.y,
    z: item.z + worldOffset.z,
  })
}
export function workingEnvelope(item: SpatialItem, worldOffset?: Point3): Bounds3 {
  const b = occupiedEnvelope(item, worldOffset),
    margin = WORKING_MARGIN[item.sku]
  return bounds3(
    b.min.x - margin,
    b.min.y,
    b.min.z - margin,
    b.max.x + margin,
    b.max.y,
    b.max.z + margin,
  )
}
export function equipmentFootprint(item: Pick<SpatialItem, 'sku' | 'rotation'>) {
  const b = rotateBounds(EQUIPMENT_ENVELOPES[item.sku], item.rotation)
  return {
    w: b.max.x - b.min.x,
    d: b.max.z - b.min.z,
    offsetX: (b.max.x + b.min.x) / 2,
    offsetZ: (b.max.z + b.min.z) / 2,
  }
}

export function usableInterior(c: SpatialConfig): Bounds3 {
  const studio = c.family === 'studio'
  // Includes skirting, finished floor and the bottom of the slatted ceiling, not the shell skin.
  return bounds3(
    -c.length / 2 + 0.635,
    FINISHED_FLOOR_Y,
    studio ? -3.705 : -3.585,
    c.length / 2 - 0.635,
    studio ? 9.44 : 8.4,
    studio ? 3.62 : 3.6,
  )
}
export function constructionOpening(c: SpatialConfig) {
  const concept = c.openingConcept ?? 'standard'
  if (c.family === 'studio' || concept !== 'standard') return { width: c.length - 1.4, center: 0 }
  const width = {
    'roll-up': 10,
    center: c.length * 0.6,
    partial: c.length / 2 - 0.6,
    full: c.length - 1.2,
  }[c.containerOpening]
  return { width, center: c.containerOpening === 'partial' ? -c.length / 4 : 0 }
}
export type SpatialZone = {
  id: string
  kind: 'physical' | 'access-guidance' | 'opening-projection'
  label: string
  bounds: Bounds3
}
export function overheadZones(c: SpatialConfig): SpatialZone[] {
  const room = usableInterior(c),
    back = c.family === 'studio' ? -3.74 : -3.62
  return [
    {
      id: 'mini-split',
      kind: 'physical',
      label: 'Modeled wall-mounted services',
      bounds: bounds3(
        c.length * 0.29 - 1.325,
        room.max.y - 1.52,
        back,
        c.length * 0.29 + 1.325,
        room.max.y - 0.59,
        back + 0.73,
      ),
    },
  ]
}
export function entranceZone(c: SpatialConfig): SpatialZone {
  const { center } = constructionOpening(c)
  return {
    id: 'entry',
    kind: 'access-guidance',
    label: 'Illustrative entry approach — not a certified clearance',
    bounds: bounds3(center - 1.6, FINISHED_FLOOR_Y, 2.3, center + 1.6, FINISHED_FLOOR_Y + 7, 4.5),
  }
}
export function roofDeckElevation(c: SpatialConfig) {
  return MODEL_HEIGHT[c.family] + (c.family === 'studio' ? 0.3 : 0) + 0.12
}
export function stairLayout(c: SpatialConfig) {
  const top = roofDeckElevation(c),
    risers = Math.ceil(top / 0.62),
    going = 0.83
  const landing = bounds3(c.length / 2 - 0.9, top - 0.5, -3.6, c.length / 2 + 3.85, top, -0.6)
  const lastZ = landing.max.z + 0.475
  return {
    top,
    risers,
    rise: (top - 0.1) / risers,
    going,
    x: c.length / 2 + 2,
    start: lastZ + (risers - 1) * going,
    landing,
    ground: 0.1,
  }
}
export function externalZones(c: SpatialConfig): SpatialZone[] {
  const zones: SpatialZone[] = [],
    top = roofDeckElevation(c),
    x = c.length / 2 - 0.75
  const physical = (id: string, label: string, bounds: Bounds3) =>
    zones.push({ id, label, bounds, kind: 'physical' })
  if (c.addons.deck) {
    physical(
      'ground-deck',
      'Ground deck structure',
      bounds3(-c.length / 2, 0, 4, c.length / 2, GROUND_DECK_Y, 12.05),
    )
    physical(
      'ground-step',
      'Ground deck step',
      bounds3(-c.length * 0.3, 0, 12.05, c.length * 0.3, 0.42, 13.05),
    )
  }
  if (c.addons.roof) {
    physical(
      'roof-deck',
      'Roof deck surface',
      bounds3(-x - 0.15, top - 0.12, -3.7, x + 0.15, top, 3.7),
    )
    for (const z of [-3.6, 3.6])
      physical(
        `roof-rail-${z}`,
        'Roof edge rail',
        bounds3(-x - 0.15, top, z - 0.15, x + 0.15, top + 3.6, z + 0.15),
      )
    physical(
      'roof-rail-left',
      'Roof end rail',
      bounds3(-x - 0.15, top, -3.6, -x + 0.15, top + 3.6, 3.6),
    )
    physical(
      'roof-rail-right',
      'Roof end rail with landing access',
      bounds3(x - 0.15, top, c.addons.stairs ? -0.45 : -3.6, x + 0.15, top + 3.6, 3.6),
    )
  }
  if (c.addons.stairs && c.addons.roof) {
    const s = stairLayout(c)
    physical('landing', 'Roof access landing', s.landing)
    physical(
      'landing-rails',
      'Landing outer rail envelope',
      bounds3(s.landing.min.x, s.top, -3.75, s.landing.max.x + 0.12, s.top + 3.6, -3.45),
    )
    physical(
      'landing-rail-outer',
      'Landing outer side rail',
      bounds3(s.landing.max.x - 0.06, s.top, -3.65, s.landing.max.x + 0.06, s.top + 3.2, -0.55),
    )
    physical(
      'landing-rail-front',
      'Landing rail beside stair arrival',
      bounds3(s.landing.min.x - 0.06, s.top, -0.66, s.x - 1.79, s.top + 3.2, -0.54),
    )
    for (const side of [-1, 1])
      physical(
        `landing-support-${side}`,
        'Landing support and footing',
        bounds3(
          s.x + side * 1.78 - 0.325,
          0,
          -3.745,
          s.x + side * 1.78 + 0.325,
          s.top - 0.5,
          -3.095,
        ),
      )
    physical(
      'stair',
      'External stair and handrails',
      bounds3(s.x - 1.9, 0, -0.75, s.x + 1.9, s.top + 3.6, s.start + 0.6),
    )
    physical(
      'stair-pad',
      'Stair ground bearing pad',
      bounds3(s.x - 2.1, 0, s.start - 0.5, s.x + 2.1, 0.1, s.start + 2),
    )
  }
  return zones
}

export type OpeningPanel = {
  id: string
  kind: 'glass' | 'solid' | 'shutter'
  width: number
  height: number
  depth: number
  center: Point3
  rotationX: number
  rotationY: number
}
/** Endpoint panel poses only. Projection zones below conservatively cover travel; no kinematic approval. */
export function openingPanels(c: SpatialConfig): OpeningPanel[] {
  const concept = c.openingConcept ?? 'standard',
    open = (c.presentation?.openingPose ?? 'open') === 'open'
  if (concept === 'open-front') return []
  const { width, center } = constructionOpening(c),
    head = MODEL_HEIGHT[c.family] - 0.9,
    height = head - FINISHED_FLOOR_Y - 0.04
  const panel = (
    id: string,
    kind: OpeningPanel['kind'],
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
  ): OpeningPanel => ({
    id,
    kind,
    width: w,
    height: h,
    depth: 0.18,
    center: { x, y, z },
    rotationX: rx,
    rotationY: ry,
  })
  if (concept === 'standard' && c.family === 'studio')
    return [
      panel(
        'studio-entry',
        'glass',
        3.2,
        7.5,
        open ? -1.6 : 0,
        FINISHED_FLOOR_Y + 3.8,
        open ? 5.42 : 3.82,
        0,
        open ? -Math.PI / 2 : 0,
      ),
    ]
  if (concept === 'standard' && c.containerOpening !== 'roll-up') return []
  if (concept === 'standard')
    return [
      panel(
        'shutter',
        'shutter',
        width,
        open ? 1.1 : height,
        center,
        head - (open ? 0.55 : height / 2),
        3.75,
      ),
    ]
  if (concept === 'raised-glazed') {
    const a = open ? (Math.PI * 5) / 12 : 0
    return [
      panel(
        'raised',
        'glass',
        width,
        height,
        center,
        head - (height / 2) * Math.cos(a),
        3.8 + (height / 2) * Math.sin(a),
        -a,
      ),
    ]
  }
  if (concept === 'sectional-glazed') {
    const count = 5,
      h = height / count
    const trackY = usableInterior(c).max.y - 0.18
    return Array.from({ length: count }, (_, i) =>
      panel(
        `section-${i}`,
        'glass',
        width,
        h - 0.025,
        center,
        open ? (i === 0 ? trackY - (h * Math.SQRT1_2) / 2 : trackY) : head - (i + 0.5) * h,
        open
          ? i === 0
            ? 3.75 - (h * Math.SQRT1_2) / 2
            : 3.75 - h * Math.SQRT1_2 - (i - 0.5) * h
          : 3.75,
        open ? (i === 0 ? -Math.PI / 4 : -Math.PI / 2) : 0,
      ),
    )
  }
  const w = width / 4,
    panels: OpeningPanel[] = []
  for (const side of [-1, 1]) {
    const hinge = center + (side * width) / 2,
      a = open ? (side * Math.PI) / 2 : 0
    for (let i = 0; i < 2; i++)
      panels.push(
        panel(
          `solid-${side}-${i}`,
          'solid',
          w - 0.025,
          height,
          open ? hinge + side * i * 0.22 : hinge - side * (i + 0.5) * w,
          head - height / 2,
          open ? 3.8 + w / 2 : 3.8,
          0,
          a,
        ),
      )
  }
  return panels
}
export function panelEnvelope(p: OpeningPanel): Bounds3 {
  const cy = Math.abs(Math.cos(p.rotationY)),
    sy = Math.abs(Math.sin(p.rotationY))
  const cx = Math.abs(Math.cos(p.rotationX)),
    sx = Math.abs(Math.sin(p.rotationX))
  const depth = p.kind === 'solid' ? 0.52 : p.id === 'studio-entry' ? 0.44 : p.depth
  const width = p.width + (p.kind === 'solid' ? 0.04 : 0)
  const w = width * cy + depth * sy,
    h = p.height * cx + depth * sx,
    d = width * sy + p.height * sx + depth * cx * cy
  return bounds3(
    p.center.x - w / 2,
    p.center.y - h / 2,
    p.center.z - d / 2,
    p.center.x + w / 2,
    p.center.y + h / 2,
    p.center.z + d / 2,
  )
}
export function openingZones(c: SpatialConfig): SpatialZone[] {
  const zones = openingPanels(c).map((p) => ({
    id: p.id,
    kind: 'physical' as const,
    label: 'Modeled opening panel',
    bounds: panelEnvelope(p),
  }))
  return zones
}
export function openingTravelZone(c: SpatialConfig): SpatialZone | null {
  const concept = c.openingConcept ?? 'standard',
    { width, center } = constructionOpening(c),
    head = MODEL_HEIGHT[c.family] - 0.9,
    h = head - FINISHED_FLOOR_Y
  if (concept === 'standard' && c.family === 'studio')
    return {
      id: 'entry-swing',
      kind: 'opening-projection',
      label: 'Illustrative entry swing',
      bounds: bounds3(-1.85, FINISHED_FLOOR_Y, 3.6, 1.85, FINISHED_FLOOR_Y + 7.6, 7.25),
    }
  if (concept === 'standard' || concept === 'open-front') return null
  return {
    id: 'opening-travel',
    kind: 'opening-projection',
    label: 'Illustrative opening travel envelope — mechanism requires engineering review',
    bounds: bounds3(
      center - width / 2 - 0.4,
      FINISHED_FLOOR_Y,
      concept === 'sectional-glazed' ? 3.6 - h : 3.6,
      center + width / 2 + 0.4,
      head + 0.2,
      concept === 'raised-glazed' ? 4 + h : concept === 'hinged-solid' ? 4 + width / 2 : 4,
    ),
  }
}

export type SpatialIssue = {
  code: 'non-finite' | 'floor' | 'wall' | 'ceiling' | 'overhead' | 'opening' | 'overlap' | 'entry'
  itemId: string
  otherId?: string
  category: 'physical' | 'access-guidance'
  message: string
}
export function placementIssues(
  item: SpatialItem,
  c: SpatialConfig & { items?: readonly SpatialItem[] },
): SpatialIssue[] {
  const issues: SpatialIssue[] = [],
    add = (
      code: SpatialIssue['code'],
      message: string,
      otherId?: string,
      category: SpatialIssue['category'] = 'physical',
    ) => issues.push({ code, itemId: item.id, category, message, ...(otherId ? { otherId } : {}) })
  if (![item.x, item.z, item.rotation].every(Number.isFinite) || ![0, 90].includes(item.rotation)) {
    add('non-finite', 'Equipment position or rotation is invalid.')
    return issues
  }
  const b = occupiedEnvelope(item),
    room = usableInterior(c),
    eps = 0.0001
  if (b.min.y < room.min.y - eps) add('floor', 'Equipment extends below the finished floor.')
  if (b.max.y > room.max.y + eps) add('ceiling', 'Equipment exceeds the finished ceiling height.')
  if (
    b.min.x < room.min.x - eps ||
    b.max.x > room.max.x + eps ||
    b.min.z < room.min.z - eps ||
    b.max.z > room.max.z + eps
  )
    add('wall', 'Equipment extends outside the usable lined floor area.')
  for (const zone of overheadZones(c))
    if (intersects(b, zone.bounds))
      add('overhead', 'Equipment intersects modeled overhead services.', zone.id)
  for (const zone of openingZones(c))
    if (intersects(b, zone.bounds))
      add('opening', 'Equipment intersects an opening panel in this presentation pose.', zone.id)
  for (const other of c.items ?? [])
    if (other.id !== item.id && intersects(b, occupiedEnvelope(other)))
      add('overlap', 'Equipment physically overlaps another item.', other.id)
  if (intersects(b, entranceZone(c).bounds))
    add(
      'entry',
      'Keep the illustrative entry approach clear; this is not a certified clearance.',
      'entry',
      'access-guidance',
    )
  return issues
}
/** Backwards-compatible string adapter; structured consumers should use placementIssues. */
export function spatialPlacementIssue(
  item: SpatialItem,
  c: SpatialConfig & { items?: readonly SpatialItem[] },
): string | null {
  return placementIssues(item, c)[0]?.message ?? null
}
export function spatialContract(c: SpatialConfig & { items?: readonly SpatialItem[] }) {
  return {
    version: SPATIAL_VERSION,
    units: 'feet' as const,
    axes: { length: 'x', up: 'y', front: '+z' },
    finishedFloor: FINISHED_FLOOR_Y,
    usable: usableInterior(c),
    overhead: overheadZones(c),
    entrance: entranceZone(c),
    external: externalZones(c),
    openings: openingZones(c),
    openingTravel: openingTravelZone(c),
    equipment: (c.items ?? []).map((item) => ({
      id: item.id,
      occupied: occupiedEnvelope(item),
      working: workingEnvelope(item),
      workingClassification: 'illustrative-not-certified' as const,
    })),
  }
}
