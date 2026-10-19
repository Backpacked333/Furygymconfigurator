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
  MAX_OCCLUSION,
  angleKey,
  aspectClassOf,
  composition,
  galleryCamera,
  nearestAngle,
  siteCheck,
  type AspectClass,
} from './gallery'
import { contains, sceneryKeepOuts } from './scenery'

const ASPECTS: AspectClass[] = ['wide', 'tall']
/** Every design the gallery should frame: both families, both sizes, every build. */
const designs: [string, Config][] = [
  ['default', DEFAULT_CONFIG],
  ['40 ft', { ...DEFAULT_CONFIG, length: 40, items: packageItems('strength', 40) }],
  ['container', setFamily(DEFAULT_CONFIG, 'container')],
  ['slatted', { ...DEFAULT_CONFIG, interiorStyle: 'slatted' }],
  ...SIGNATURES.map((s): [string, Config] => [s.id, s.config]),
]
/** The default design and the signature builds, each with its own front three-quarter view. */
const builds: [string, Config, [number, number, number]][] = [
  ['default', DEFAULT_CONFIG, DEFAULT_CAMERA],
  ...SIGNATURES.map((s): [string, Config, [number, number, number]] => [s.id, s.config, s.camera]),
]
const exterior = GALLERY_ANGLES.filter((a) => a.group === 'exterior')
const interior = GALLERY_ANGLES.filter((a) => a.group === 'interior')
const length = (v: number[]) => Math.hypot(...v)
/** Degrees around the build, from the front (+z) toward its left (+x). */
const azimuth = (c: { position: number[]; target: number[] }) =>
  (Math.atan2(c.position[0] - c.target[0], c.position[2] - c.target[2]) * 180) / Math.PI
const minus = (a: number[], b: number[]) => a.map((v, i) => v - b[i]) as [number, number, number]

describe('gallery angles', () => {
  it('keeps signature heroes distinct from their front elevations', () => {
    for (const [name, config, hero] of builds) {
      const front = galleryCamera(config, 'front', 'wide', hero)
      const threeQuarter = galleryCamera(config, 'front-left', 'wide', hero)
      expect(Math.abs(azimuth(threeQuarter) - azimuth(front)), name).toBeGreaterThan(20)
    }
  })

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
    // A bench there: the camera steps off it too. A mat there is stood on.
    const bench = { ...rack, sku: 'bench' as const }
    const stepped = galleryCamera({ ...DEFAULT_CONFIG, items: [bench] }, 'entry', 'wide')
    expect(
      Math.abs(stepped.position[0] - bench.x) > 1.9 / 2 + 0.4 ||
        Math.abs(stepped.position[2] - bench.z) > 4.3 / 2 + 0.4,
    ).toBe(true)
    // A mat is flooring: mats over the whole entry end of the room leave the entry camera there,
    // standing on one.
    const mats = [3.6, 5.9, 8.2].flatMap((x) =>
      [-1.1, 1.8].map((z) => ({
        id: `m${x}${z}`,
        sku: 'mat' as const,
        x,
        z,
        rotation: 90 as const,
      })),
    )
    const onMat = galleryCamera({ ...DEFAULT_CONFIG, items: mats }, 'entry', 'wide')
    expect(onMat.position[0]).toBeGreaterThan(2.5)
    expect(
      mats.some(
        (m) => Math.abs(onMat.position[0] - m.x) <= 2.7 && Math.abs(onMat.position[2] - m.z) <= 1.1,
      ),
    ).toBe(true)
  })

  it('stand at eye height, give or take half a foot', () => {
    for (const [name, config] of designs)
      for (const aspect of ASPECTS)
        for (const { id } of interior) {
          const c = galleryCamera(config, id, aspect)
          const eye = c.position[1] - FLOOR_Y
          expect(Math.abs(eye - 4.85), `${name} ${id} ${aspect}`).toBeLessThanOrEqual(0.5 + 1e-9)
        }
  })

  it("frame each build's main piece whole, with the room around it", () => {
    // Every design but the clubhouse, whose three half racks leave a strip a foot deep to stand
    // in: each interior picture shows the room's main piece (a rack, the trainer, the reformer)
    // nearly whole and in view, and a good share of the rest of its equipment, without letting
    // it crowd out the room.
    for (const [name, config] of designs) {
      if (name === 'clubhouse') continue
      for (const aspect of ASPECTS)
        for (const { id } of interior) {
          const seen = composition(config, galleryCamera(config, id, aspect), aspect)
          const what = `${name} ${id} ${aspect}`
          expect(seen.main, `${what} main piece`).toBeGreaterThanOrEqual(0.85)
          expect(seen.clearest, what).toBeGreaterThanOrEqual(0.9)
          expect(seen.subject, `${what} equipment shown`).toBeGreaterThanOrEqual(0.35)
          expect(seen.fill, `${what} fill`).toBeLessThanOrEqual(0.6)
        }
    }
  })

  it('never leave a picture mostly blank wall or ceiling, or empty of equipment', () => {
    // Blank wall (a far one counting less), ceiling and a little floor stay well short of most
    // of the frame, in every design, the cramped clubhouse too, and every picture of a room with
    // equipment shows some of it, at least one piece of it whole.
    for (const [name, config] of designs)
      for (const aspect of ASPECTS)
        for (const { id } of interior) {
          const seen = composition(config, galleryCamera(config, id, aspect), aspect)
          const what = `${name} ${id} ${aspect}`
          expect(seen.empty, `${what} empty`).toBeLessThanOrEqual(0.55)
          expect(seen.fill, `${what} fill`).toBeGreaterThanOrEqual(0.08)
          expect(seen.clearest, `${what} clearest`).toBeGreaterThanOrEqual(0.6)
        }
    // An empty room is the room itself: its depth and the setting through the glazing.
    const bare = { ...DEFAULT_CONFIG, items: [] }
    for (const aspect of ASPECTS)
      for (const { id } of interior) {
        const seen = composition(bare, galleryCamera(bare, id, aspect), aspect)
        expect(seen.empty, `empty room ${id} ${aspect}`).toBeLessThanOrEqual(0.55)
        expect(seen.outside, `empty room ${id} ${aspect}`).toBeLessThanOrEqual(0.55)
      }
  })

  it('beat the cameras that left the strength room mostly blank wall', () => {
    // The centre and back views of the default design had turned to the dumbbell station and
    // blank wall, the rack and bench out of the picture; now both show the rack whole.
    const before = {
      centre: { position: [2, 6.31, 2.87], target: [3.5, 4.26, -3.34], fov: 68 },
      back: { position: [-1.78, 5.81, 1.92], target: [4.97, 4.6, -0.71], fov: 68 },
    } as const
    for (const id of ['centre', 'back'] as const) {
      const was = composition(
        DEFAULT_CONFIG,
        {
          position: [...before[id].position],
          target: [...before[id].target],
          fov: before[id].fov,
        },
        'wide',
      )
      const now = composition(DEFAULT_CONFIG, galleryCamera(DEFAULT_CONFIG, id, 'wide'), 'wide')
      expect(was.main, id).toBeLessThan(0.1)
      expect(now.main, id).toBeGreaterThan(0.85)
      expect(now.subject, id).toBeGreaterThan(was.subject + 0.2)
      expect(now.empty, id).toBeLessThan(was.empty)
    }
  })

  it('compose the room: nothing near the lens crowds it, where the layout allows', () => {
    // Crowding is a cost, not a rule, so a cramped room still gets its best picture; where the
    // layout leaves room, nothing near the lens fills much more than 15 % of the picture, or
    // reaches much past halfway into it from the edge that cuts it.
    for (const [name, config] of designs) {
      if (name === 'clubhouse') continue
      for (const aspect of ASPECTS)
        for (const { id } of interior) {
          const seen = composition(config, galleryCamera(config, id, aspect), aspect)
          const what = `${name} ${id} ${aspect}`
          expect(seen.crowding, what).toBeLessThanOrEqual(0.25)
          expect(seen.intrusion, what).toBeLessThanOrEqual(0.55)
          expect(seen.cut, what).toBeLessThanOrEqual(0.2)
        }
    }
  })

  it('give each interior angle a view of its own', () => {
    // The entry from the entry's end, looking down the room; the centre looking across it at its
    // main piece; the back from the back wall or the far end, looking toward the glazing or the
    // entry. Any two stand 3 feet apart or look 45° apart, but where the layout leaves no third
    // view (the courtyard pod's narrow phone frame).
    const heading = (c: { position: number[]; target: number[] }) =>
      Math.atan2(c.target[2] - c.position[2], c.target[0] - c.position[0])
    const apart = (a: number, b: number) =>
      (Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180) / Math.PI
    for (const [name, config] of designs)
      for (const aspect of ASPECTS) {
        const [entry, centre, back] = interior.map(({ id }) => galleryCamera(config, id, aspect))
        const b = interiorBounds(config)
        const what = `${name} ${aspect}`
        // The entry's end is +x for these builds' doors.
        expect(entry.position[0], `${what} entry`).toBeGreaterThan(0)
        expect(-Math.cos(heading(entry)), `${what} entry looks down the room`).toBeGreaterThan(0.4)
        expect(-Math.sin(heading(centre)), `${what} centre looks across`).toBeGreaterThan(0.15)
        const looksBack = Math.sin(heading(back)) >= 0.15 || Math.cos(heading(back)) >= 0.45
        const standsBack =
          back.position[2] <= (b.back + b.front) / 2 || back.position[0] <= -0.35 * b.halfWidth
        if (name !== 'clubhouse') expect(standsBack, `${what} back stands back`).toBe(true)
        expect(looksBack, `${what} back looks toward the glazing or the entry`).toBe(true)
        if (name === 'courtyard-pod' && aspect === 'tall') continue
        for (const [a, c] of [
          [entry, centre],
          [entry, back],
          [centre, back],
        ]) {
          const spot = Math.hypot(a.position[0] - c.position[0], a.position[2] - c.position[2])
          expect(spot >= 3 - 1e-6 || apart(heading(a), heading(c)) >= 45 - 1e-6, what).toBe(true)
        }
      }
  })

  it('keep its lens within the drawn field of view, and the camera close to level', () => {
    for (const [name, config] of designs)
      for (const aspect of ASPECTS)
        for (const { id } of interior) {
          const c = galleryCamera(config, id, aspect)
          const drawn = aspect === 'wide' ? 68 : 78
          expect(c.fov, `${name} ${id} ${aspect}`).toBeLessThanOrEqual(drawn)
          expect(c.fov).toBeGreaterThanOrEqual(drawn - 12)
          const d = minus(c.target, c.position)
          const down = (Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI
          expect(down, `${name} ${id} ${aspect} pitch`).toBeGreaterThanOrEqual(2 - 1e-6)
          expect(down).toBeLessThanOrEqual(12 + 1e-6)
        }
  })

  it("keep the strength rack's bar out of the back view, and its plate off the centre's edge", () => {
    const config = DEFAULT_CONFIG
    // The cameras these angles had: the bar ran across the back view from beside the lens, and
    // the centre view cut the rack and its plate at the frame's edge.
    const before = {
      back: { position: [-7.78, 5.81, 2.42], target: [4.97, 4.6, -0.71], fov: 68 },
      centre: { position: [4, 5.81, 2.87], target: [0, 4.26, -3.34], fov: 68 },
    } as const
    const back = composition(config, galleryCamera(config, 'back', 'wide'), 'wide')
    const wasBack = composition(
      config,
      { ...before.back, position: [...before.back.position], target: [...before.back.target] },
      'wide',
    )
    // The bar reached all the way across; now nothing near the lens reaches halfway in.
    expect(wasBack.intrusion).toBeGreaterThan(0.9)
    expect(back.intrusion).toBeLessThan(0.5)
    expect(back.crowding).toBeLessThanOrEqual(0.15)
    const centre = composition(config, galleryCamera(config, 'centre', 'wide'), 'wide')
    const wasCentre = composition(
      config,
      {
        ...before.centre,
        position: [...before.centre.position],
        target: [...before.centre.target],
      },
      'wide',
    )
    expect(wasCentre.intrusion).toBeGreaterThan(0.35)
    expect(centre.intrusion).toBeLessThan(wasCentre.intrusion)
    expect(centre.cut).toBeLessThan(wasCentre.cut)
    expect(centre.crowding).toBeLessThanOrEqual(0.15)
  })

  it('stand outside every shape of every setting, seeing at least 80 % of the build', () => {
    // Every setting, the default design and each signature build, from its own front three-quarter
    // view and from the default one (a shared link), both stage shapes.
    for (const { id: environment } of ENVIRONMENTS) {
      const shapes = sceneryKeepOuts({ environment, length: 20 })
      for (const [name, base, own] of builds)
        for (const hero of [own, DEFAULT_CAMERA])
          for (const aspect of ASPECTS)
            for (const { id } of exterior) {
              const config = { ...base, environment }
              const camera = galleryCamera(config, id, aspect, hero)
              const what = `${environment} ${name} ${id} ${aspect}`
              const at = shapes.find((k) => contains(k, camera.position, 1))
              expect(at?.kind ?? null, `${what} stands in`).toBeNull()
              expect(camera.position[1], what).toBeGreaterThan(1)
              const site = siteCheck(config, camera, aspect)
              expect(site.inside, what).toBeNull()
              expect(site.occlusion, `${what} occlusion`).toBeLessThanOrEqual(MAX_OCCLUSION)
            }
    }
    expect(MAX_OCCLUSION).toBe(0.2)
  })

  it('see the whole build, base and all, wherever the setting allows', () => {
    for (const { id: environment } of ENVIRONMENTS)
      for (const [name, base] of designs)
        for (const aspect of ASPECTS)
          for (const { id } of exterior) {
            const config = { ...base, environment }
            const site = siteCheck(config, galleryCamera(config, id, aspect), aspect)
            const what = `${environment} ${name} ${id} ${aspect}`
            expect(site.inside, what).toBeNull()
            expect(site.occlusion, what).toBeLessThanOrEqual(MAX_OCCLUSION)
            // Never the base behind a planter, a hedge or a wall in front of it.
            expect(site.buried, what).toBeLessThanOrEqual(0.15)
            // The setting frames the build: its trees and posts never fill more than half the
            // picture in front of it (the walled garden's rear views come closest).
            expect(site.foreground, what).toBeLessThanOrEqual(0.5)
          }
    // The default design in its own courtyard, and in the studio: nothing in the way.
    for (const environment of ['residences', 'studio'] as const)
      for (const aspect of ASPECTS)
        for (const { id } of exterior) {
          const config = { ...DEFAULT_CONFIG, environment }
          const site = siteCheck(config, galleryCamera(config, id, aspect), aspect)
          expect(site.occlusion, `${environment} ${id} ${aspect}`).toBe(0)
          expect(site.buried).toBe(0)
        }
  })

  it('stand in front of a building that closes the view, closer in and wider', () => {
    // In the residential courtyard an apartment block closes the view from behind: the camera
    // stands in front of it with a wider lens; in the studio it keeps its framing.
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

  it('swing up to 35° around a tree, staying nearer their own angle than any other', () => {
    const drawn = Object.fromEntries(
      exterior.map((a) => [
        a.id,
        azimuth({ position: a.direction ?? DEFAULT_CAMERA, target: [0, 0, 0] }),
      ]),
    )
    const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)
    let swung = 0
    for (const { id: environment } of ENVIRONMENTS)
      for (const [, base] of builds)
        for (const aspect of ASPECTS)
          for (const { id } of exterior) {
            // The view from above is a matter of elevation; the hero is the build's own.
            if (id === 'top' || id === 'front-left') continue
            const camera = galleryCamera({ ...base, environment }, id, aspect)
            const around = azimuth(camera)
            // The rear quarter may be taken from the other rear quarter.
            const own = Math.min(
              apart(around, drawn[id]),
              id === 'rear-left' ? apart(around, -drawn[id]) : Infinity,
            )
            expect(own, `${environment} ${id} ${aspect}`).toBeLessThanOrEqual(35 + 1e-6)
            for (const other of exterior)
              if (other.id !== id && other.id !== 'top')
                expect(
                  apart(around, drawn[other.id]),
                  `${environment} ${id} by ${other.id}`,
                ).toBeGreaterThan(own)
            if (own > 1) swung++
          }
    expect(swung).toBeGreaterThan(0)
  })

  it('take the rear quarter from the other side when that side is clearer', () => {
    // In the open, the rear quarter as drawn.
    const open = galleryCamera({ ...DEFAULT_CONFIG, environment: 'studio' }, 'rear-left', 'wide')
    expect(azimuth(open)).toBeCloseTo(
      azimuth({ position: [0.62, 0.34, -0.78], target: [0, 0, 0] }),
      3,
    )
    // Some build and setting finds the other rear quarter clearer; most keep their own.
    const quarters = builds.flatMap(([, base]) =>
      ENVIRONMENTS.map(({ id: environment }) =>
        azimuth(galleryCamera({ ...base, environment }, 'rear-left', 'wide')),
      ),
    )
    expect(quarters.filter((a) => a < -90).length).toBeGreaterThan(0)
    expect(quarters.filter((a) => a > 90).length).toBeGreaterThan(quarters.length / 2)
  })

  it('look over the planters from behind, rather than through them from low down', () => {
    const config = DEFAULT_CONFIG
    const rear = galleryCamera(config, 'rear', 'wide')
    expect(siteCheck(config, rear).buried).toBe(0)
    expect(rear.position[2]).toBeLessThan(-20)
    // In the walled garden, over the wall.
    const garden = { ...DEFAULT_CONFIG, environment: 'desert' as const }
    for (const id of ['rear', 'rear-left'] as const)
      expect(siteCheck(garden, galleryCamera(garden, id, 'wide')).buried, id).toBeLessThanOrEqual(
        0.15,
      )
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
