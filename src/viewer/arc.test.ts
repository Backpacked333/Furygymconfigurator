import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDesign, type DesignEnvelope } from '../domain/design'
import { createSceneDesignFixtures } from '../domain/designFixtures'
import { CUSTOMER_CAMERAS, LOOK_REFS, resolveCamera } from '../domain/presentation'
import { resolveNativeCamera } from '../render/nativeCamera'
import {
  ARC_MARGIN,
  arcAround,
  arcWindow,
  azimuthOf,
  cameraAzimuths,
  coveringArc,
  requestedArc,
} from './arc'
import { FREE_ORBIT, UNLIMITED_ARC, room, type ArcWindow } from './orbitWindow'

const deg = Math.PI / 180
const width = (window: ArcWindow) => (window.max - window.min) / deg
const exteriorRefs = CUSTOMER_CAMERAS.filter((c) => c.group === 'exterior').map((c) => c.ref)
const cameraAzimuth = (design: DesignEnvelope, cameraRef: string) => {
  const camera = resolveNativeCamera({
    ...design,
    presentation: { ...design.presentation, cameraRef },
  })
  return azimuthOf(camera.position, camera.target)
}

describe('?arc= request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accepts a minimum window from 30° up to a full turn', () => {
    expect(requestedArc('?arc=180')).toBe(180)
    expect(requestedArc('?experience=library&arc=30')).toBe(30)
    expect(requestedArc('?arc=359.5')).toBe(359.5)
  })
  it('ignores anything else, so the orbit stays free', () => {
    for (const search of [
      '',
      '?arc',
      '?arc=',
      '?arc=%20',
      '?arc=abc',
      '?arc=0',
      '?arc=-90',
      '?arc=29',
      '?arc=360',
      '?arc=1e9',
      '?arc=Infinity',
      '?arc=NaN',
    ])
      expect(requestedArc(search), search).toBeNull()
  })
  it('reads the page address by default', () => {
    vi.stubGlobal('window', { location: { search: '?quality=lite&arc=200' } })
    expect(requestedArc()).toBe(200)
  })
})

describe('arc window geometry', () => {
  it('covers azimuths with the smallest arc, going round behind the build when shorter', () => {
    const plain = coveringArc([29.7 * deg, 0, 85.4 * deg, 141.5 * deg])
    expect(plain.start).toBeCloseTo(0)
    expect(plain.span / deg).toBeCloseTo(141.5)
    // Naively min to max, these two would span 340°.
    const behind = coveringArc([170 * deg, -170 * deg])
    expect(behind.start / deg).toBeCloseTo(170)
    expect(behind.span / deg).toBeCloseTo(20)
    // The courtyard's rear quarter taken from the other side.
    const mirrored = coveringArc([29.7 * deg, 0, 85.4 * deg, -151.5 * deg])
    expect(mirrored.start).toBeCloseTo(0)
    expect(mirrored.span / deg).toBeCloseTo(208.5)
    expect(coveringArc([1]).span).toBe(0)
  })
  it('leaves the margin past the outermost cameras', () => {
    const window = arcAround([0, 29.7 * deg, 141.5 * deg], 30)
    expect(window.min / deg).toBeCloseTo(-ARC_MARGIN)
    expect(window.max / deg).toBeCloseTo(141.5 + ARC_MARGIN)
  })
  it('treats the request as a minimum, widened evenly about the cameras', () => {
    const window = arcAround([0, 20 * deg], 180)
    expect(window.min / deg).toBeCloseTo(-80)
    expect(window.max / deg).toBeCloseTo(100)
    expect(width(arcAround([0, 20 * deg], 30))).toBeCloseTo(40)
  })
  it('keeps the centre within ±180° and the window continuous across it', () => {
    const window = arcAround([170 * deg, -170 * deg], 30)
    expect(Math.abs((window.min + window.max) / 2)).toBeLessThanOrEqual(Math.PI)
    expect(width(window)).toBeCloseTo(40)
    for (const theta of [170 * deg, -170 * deg])
      for (const way of [1, -1] as const)
        expect(room(window, theta, way) / deg).toBeGreaterThanOrEqual(ARC_MARGIN - 1e-3)
  })
  it(`is no limit from ${UNLIMITED_ARC}° up`, () => {
    expect(arcAround([0, 120 * deg], 350)).toBe(FREE_ORBIT)
    expect(width(arcAround([0, 120 * deg], 349.9))).toBeCloseTo(349.9)
    // Cameras all round need more than any request.
    const round = Array.from({ length: 24 }, (_, i) => i * 15 * deg)
    expect(arcAround(round, 30)).toBe(FREE_ORBIT)
  })
})

describe('arc window for a design', () => {
  const designs = createSceneDesignFixtures().flatMap(({ id, design }) =>
    LOOK_REFS.flatMap((lookRef) =>
      (['wide', 'tall'] as const).map((aspect) => ({
        name: `${id} ${lookRef} ${aspect}`,
        design: parseDesign({
          ...design,
          presentation: { ...design.presentation, lookRef, aspect },
        }),
      })),
    ),
  )

  it('keeps every exterior customer camera and the design’s own in reach, with margin', () => {
    let wider = 0
    for (const { name, design } of designs) {
      const own = resolveCamera(design.presentation.cameraRef)
      const refs = [...exteriorRefs, ...(own.group === 'exterior' ? [own.ref] : [])]
      for (const degrees of [30, 180]) {
        const window = arcWindow(design, degrees)
        expect(Number.isFinite(window.min), name).toBe(true)
        expect(width(window), name).toBeLessThan(UNLIMITED_ARC)
        expect(width(window), name).toBeGreaterThanOrEqual(degrees - 1e-9)
        expect(Math.abs((window.min + window.max) / 2), name).toBeLessThanOrEqual(Math.PI)
        for (const ref of refs)
          for (const way of [1, -1] as const)
            expect(
              room(window, cameraAzimuth(design, ref), way) / deg,
              `${name} ${ref}`,
            ).toBeGreaterThanOrEqual(ARC_MARGIN - 1e-3)
      }
      if (width(arcWindow(design, 30)) > 180) wider++
    }
    // The designs a fixed 180° would get wrong are in the matrix.
    expect(wider).toBeGreaterThan(0)
  })

  it('widens past 180° where the rear three-quarter view is taken from the other side', () => {
    const base = createSceneDesignFixtures().find((f) => f.id === 'studio-20-baseline')!.design
    const courtyard = parseDesign({
      ...base,
      presentation: { ...base.presentation, lookRef: 'courtyard-day-draft@1', aspect: 'wide' },
    })
    const rear = cameraAzimuth(courtyard, 'rear-left-draft@1')
    expect(rear).toBeLessThan(0)
    const window = arcWindow(courtyard, 180)
    expect(width(window)).toBeGreaterThan(200)
    expect(room(window, rear, 1) / deg).toBeCloseTo(ARC_MARGIN)
    expect(arcWindow(courtyard, 355)).toBe(FREE_ORBIT)
  })

  it('reaches a design’s own exterior camera, not an interior one', () => {
    const base = createSceneDesignFixtures()[0].design
    const opening = (cameraRef: string) =>
      parseDesign({ ...base, presentation: { ...base.presentation, cameraRef } })
    const four = exteriorRefs.map((ref) => cameraAzimuth(base, ref))
    // A saved design that opens at the retired view from above.
    const above = opening('top-draft@1')
    expect(cameraAzimuths(above)).toEqual([...four, cameraAzimuth(above, 'top-draft@1')])
    expect(cameraAzimuths(opening('entry-draft@1'))).toEqual(four)
    expect(cameraAzimuths(opening('rear-left-draft@1'))).toEqual(four)
    expect(arcWindow(above, 30)).toEqual(arcAround(cameraAzimuths(above), 30))
  })
})
