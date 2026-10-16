import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAMERA,
  DEFAULT_CONFIG,
  ENVIRONMENTS,
  SIGNATURES,
  packageItems,
  setFamily,
  type Config,
} from '../lib/config'
import { FLOOR_Y, interiorBounds } from './envelope'
import {
  ASPECT_RATIO,
  GALLERY_ANGLES,
  angleKey,
  aspectClassOf,
  galleryCamera,
  inScenery,
  nearestAngle,
  siteCheck,
  type AspectClass,
} from './gallery'

const ASPECTS: AspectClass[] = ['wide', 'tall']
/** Every design the gallery should frame: both families, both sizes, every build. */
const designs: [string, Config][] = [
  ['default', DEFAULT_CONFIG],
  ['40 ft', { ...DEFAULT_CONFIG, length: 40, items: packageItems('strength', 40) }],
  ['container', setFamily(DEFAULT_CONFIG, 'container')],
  ['slatted', { ...DEFAULT_CONFIG, interiorStyle: 'slatted' }],
  ...SIGNATURES.map((s): [string, Config] => [s.id, s.config]),
]
const length = (v: number[]) => Math.hypot(...v)
const minus = (a: number[], b: number[]) => a.map((v, i) => v - b[i]) as [number, number, number]

describe('gallery angles', () => {
  it('are six outside and three in the room, the front three-quarter view first', () => {
    expect(GALLERY_ANGLES.map((a) => a.id)).toEqual([
      'front-left',
      'front',
      'left',
      'rear-left',
      'rear',
      'top',
      'entry',
      'centre',
      'back',
    ])
    expect(GALLERY_ANGLES.filter((a) => a.group === 'interior')).toHaveLength(3)
  })

  it('are the same camera every time for the same design and stage shape', () => {
    for (const [, config] of designs)
      for (const aspect of ASPECTS)
        for (const { id } of GALLERY_ANGLES)
          expect(galleryCamera(structuredClone(config), id, aspect)).toEqual(
            galleryCamera(config, id, aspect),
          )
  })

  it('frame the build from further away on a tall stage, which is narrower', () => {
    // In the open, where no building stands in the way.
    const open = { ...DEFAULT_CONFIG, environment: 'studio' as const }
    for (const { id, group } of GALLERY_ANGLES) {
      if (group !== 'exterior') continue
      const wide = galleryCamera(open, id, 'wide')
      const tall = galleryCamera(open, id, 'tall')
      expect(wide.target).toEqual(tall.target)
      expect(length(minus(tall.position, tall.target))).toBeGreaterThan(
        length(minus(wide.position, wide.target)),
      )
    }
  })

  it("look at the front three-quarter view from the build's own direction", () => {
    const view = (hero?: [number, number, number]) => {
      const c = galleryCamera(DEFAULT_CONFIG, 'front-left', 'wide', hero)
      const d = minus(c.position, c.target)
      return d.map((v) => v / length(d))
    }
    const toward = (v: number[]) => v.map((x) => x / length(v))
    view().forEach((v, i) => expect(v).toBeCloseTo(toward(DEFAULT_CAMERA)[i], 6))
    const campus = SIGNATURES.find((s) => s.id === 'campus-pod')!
    view(campus.camera).forEach((v, i) => expect(v).toBeCloseTo(toward(campus.camera)[i], 6))
    // The other angles keep their own directions whatever the build's.
    expect(galleryCamera(DEFAULT_CONFIG, 'rear', 'wide', campus.camera)).toEqual(
      galleryCamera(DEFAULT_CONFIG, 'rear', 'wide'),
    )
  })

  it('stand inside the room, clear of its walls, at eye height, looking into it', () => {
    for (const [name, config] of designs) {
      const b = interiorBounds(config)
      const inside = ([x, y, z]: number[]) =>
        Math.abs(x) < b.halfWidth && z > b.back && z < b.front && y > FLOOR_Y && y < b.ceiling
      for (const aspect of ASPECTS)
        for (const { id, group } of GALLERY_ANGLES) {
          if (group !== 'interior') continue
          const c = galleryCamera(config, id, aspect)
          expect(inside(c.position), `${name} ${id} ${aspect} camera`).toBe(true)
          expect(inside(c.target), `${name} ${id} ${aspect} target`).toBe(true)
          expect(Math.abs(c.position[0])).toBeLessThanOrEqual(b.halfWidth - 0.5)
          expect(c.position[2]).toBeLessThanOrEqual(b.front - 0.5)
          expect(c.position[1] - FLOOR_Y).toBeGreaterThan(4)
        }
    }
  })

  it('stand clear of tall equipment where the room allows', () => {
    // A rack where the entry camera would stand: it moves along to a clear spot.
    const rack = { id: 'r', sku: 'rack' as const, x: 6.9, z: -0.2, rotation: 0 as const }
    const crowded = { ...DEFAULT_CONFIG, items: [rack] }
    const c = galleryCamera(crowded, 'entry', 'wide')
    const clear =
      Math.abs(c.position[0] - rack.x) > 2.4 + 0.8 || Math.abs(c.position[2] - rack.z) > 1.6 + 0.8
    expect(clear).toBe(true)
    expect(c).not.toEqual(galleryCamera({ ...DEFAULT_CONFIG, items: [] }, 'entry', 'wide'))
    // A low bench there leaves it where it was.
    const bench = { ...rack, sku: 'bench' as const }
    expect(galleryCamera({ ...DEFAULT_CONFIG, items: [bench] }, 'entry', 'wide')).toEqual(
      galleryCamera({ ...DEFAULT_CONFIG, items: [] }, 'entry', 'wide'),
    )
  })

  it("stand outside the setting's buildings, closer in and wider where one is behind", () => {
    for (const { id: environment } of ENVIRONMENTS)
      for (const [name, base] of designs) {
        const config = { ...base, environment }
        for (const aspect of ASPECTS)
          for (const { id, group } of GALLERY_ANGLES) {
            if (group !== 'exterior') continue
            const c = galleryCamera(config, id, aspect)
            expect(
              inScenery(config, c.position[0], c.position[2]),
              `${environment} ${name} ${id}`,
            ).toBe(false)
            expect(c.position[1]).toBeGreaterThan(1)
          }
      }
    // In the residential courtyard an apartment block closes the view from behind: the camera
    // stands in front of it with a wider lens; on the open campus it keeps its framing.
    const courtyard = galleryCamera(
      { ...DEFAULT_CONFIG, environment: 'residences' },
      'rear',
      'wide',
    )
    const open = galleryCamera({ ...DEFAULT_CONFIG, environment: 'studio' }, 'rear', 'wide')
    expect(courtyard.position[2]).toBeGreaterThan(-34)
    expect(courtyard.fov).toBeGreaterThan(open.fov)
    expect(open.position[2]).toBeLessThan(courtyard.position[2])
  })

  it('see the whole build past the trees and over the planters of every setting', () => {
    for (const { id: environment } of ENVIRONMENTS)
      for (const [name, base] of designs) {
        const config = { ...base, environment }
        for (const aspect of ASPECTS)
          for (const { id, group } of GALLERY_ANGLES) {
            if (group !== 'exterior') continue
            const site = siteCheck(config, galleryCamera(config, id, aspect))
            const what = `${environment} ${name} ${id} ${aspect}`
            expect(site.inCrown, what).toBe(false)
            expect(site.buried, what).toBe(0)
            // At most a corner seen through foliage (the roof-deck build behind the garden's trees).
            expect(site.hidden, what).toBeLessThanOrEqual(0.34)
          }
      }
    // The default design, in its own courtyard: every angle entirely clear.
    for (const aspect of ASPECTS)
      for (const { id, group } of GALLERY_ANGLES) {
        if (group !== 'exterior') continue
        expect(siteCheck(DEFAULT_CONFIG, galleryCamera(DEFAULT_CONFIG, id, aspect))).toEqual({
          hidden: 0,
          buried: 0,
          inCrown: false,
        })
      }
  })

  it('look over the planters from behind, rather than through them from low down', () => {
    const rear = galleryCamera(DEFAULT_CONFIG, 'rear', 'wide')
    const ray = minus(rear.position, rear.target)
    const elevation = (Math.asin(ray[1] / length(ray)) * 180) / Math.PI
    expect(elevation).toBeGreaterThan(20)
    expect(rear.position[2]).toBeLessThan(-20)
  })

  it('return from the 360° view to the angle nearest its camera', () => {
    for (const [name, config] of designs)
      for (const aspect of ASPECTS)
        for (const { id, group } of GALLERY_ANGLES) {
          const c = galleryCamera(config, id, aspect)
          const pose = { position: c.position, forward: minus(c.target, c.position) }
          expect(nearestAngle(config, group, pose, aspect), `${name} ${id} ${aspect}`).toBe(id)
        }
    // Orbited a little way round from the rear: still the rear.
    const rear = galleryCamera(DEFAULT_CONFIG, 'rear', 'wide')
    const turn = 0.2
    const [x, y, z] = minus(rear.position, rear.target)
    const turned = [
      rear.target[0] + x * Math.cos(turn) + z * Math.sin(turn),
      rear.target[1] + y,
      rear.target[2] - x * Math.sin(turn) + z * Math.cos(turn),
    ] as [number, number, number]
    const away = { position: turned, forward: minus(rear.target, turned) }
    expect(nearestAngle(DEFAULT_CONFIG, 'exterior', away, 'wide')).toBe('rear')
    // Straight above the build: the view from above.
    const above = {
      position: [0, 80, 1] as [number, number, number],
      forward: [0, -1, 0] as [number, number, number],
    }
    expect(nearestAngle(DEFAULT_CONFIG, 'exterior', above, 'wide')).toBe('top')
    // Inside, turned round from the entry to look back the other way: the back view.
    const entry = galleryCamera(DEFAULT_CONFIG, 'entry', 'wide')
    const back = { position: entry.position, forward: minus(entry.position, entry.target) }
    expect(nearestAngle(DEFAULT_CONFIG, 'interior', back, 'wide')).toBe('back')
  })

  it('keep the same camera through edits that do not move it', () => {
    const later = { ...DEFAULT_CONFIG, time: 20, finish: 'graphite' as const, lights: false }
    for (const { id } of GALLERY_ANGLES)
      expect(galleryCamera(later, id, 'wide')).toEqual(galleryCamera(DEFAULT_CONFIG, id, 'wide'))
    // A camera handed out is the caller's own.
    const a = galleryCamera(DEFAULT_CONFIG, 'front', 'wide')
    a.position[0] = 999
    expect(galleryCamera(DEFAULT_CONFIG, 'front', 'wide').position[0]).not.toBe(999)
  })

  it("key the hero angle by the build's direction only when it is not the default", () => {
    expect(angleKey('front-left')).toBe('front-left')
    expect(angleKey('front-left', DEFAULT_CAMERA)).toBe('front-left')
    expect(angleKey('front-left', [0.16, 0.12, 1])).toBe('front-left~0.160,0.120,1.000')
    expect(angleKey('rear', [0.16, 0.12, 1])).toBe('rear')
  })

  it('tell the stage shape from its size', () => {
    expect(aspectClassOf(1600, 1000)).toBe('wide')
    expect(aspectClassOf(400, 500)).toBe('tall')
    expect(ASPECT_RATIO.wide).toBeCloseTo(1.6, 6)
    expect(ASPECT_RATIO.tall).toBeCloseTo(0.8, 6)
  })
})
