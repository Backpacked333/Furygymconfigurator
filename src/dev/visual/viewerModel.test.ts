import { describe, expect, it } from 'vitest'
import { Vector3, Quaternion } from 'three'
import { canRestoreCamera } from '../../lib/camera'
import { presentationBounds } from '../../lib/spatial'
import { VISUAL_FIXTURES } from './fixtures'
import {
  fixtureScenePolicy,
  fixtureValidity,
  inspectFixture,
  seedFixtureCamera,
} from './viewerModel'

describe('production fixture viewer model', () => {
  it('reports production camera constraints and view-dependent exposure, not fake fixed exposure', () => {
    expect(
      fixtureScenePolicy(inspectFixture('VF10', 'studio-threshold')).orbitConstraintWarning,
    ).toMatch(/clamped/)
    expect(fixtureScenePolicy(inspectFixture('VF02', 'strength-day')).orbitConstraintWarning).toBe(
      null,
    )
    expect(
      fixtureScenePolicy(inspectFixture('VF02', 'strength-interior'))
        .exposureExpectedFromProductionPolicy,
    ).toBe(1.6)
  })
  it('reports all original and corrected D2 outcomes without hiding repair cases', () => {
    const rows = fixtureValidity()
    expect(rows).toHaveLength(38)
    expect(rows.every((r) => r.status === 'accepted' && r.issues.length === 0)).toBe(true)
    expect(rows.filter((r) => r.originalStatus === 'repair')).toHaveLength(7)
    expect(
      rows
        .filter((r) => r.originalStatus === 'repair')
        .every((r) => r.originalIssues.length && r.adjustments.length),
    ).toBe(true)
  })
  it('seeds every shot with production bounds key/reset and an exact look-at quaternion', () => {
    for (const fixture of VISUAL_FIXTURES)
      for (const shot of fixture.shots) {
        const resolved = inspectFixture(fixture.id, shot.id)
        const memory = seedFixtureCamera(resolved)
        const snapshot = memory.current[shot.view === 'interior' ? 'interior' : 'exterior']!
        expect(snapshot.position).toEqual(shot.camera.position)
        expect(snapshot.target).toEqual(shot.camera.target)
        expect(snapshot.fov).toBe(shot.camera.fov)
        const bounds = JSON.stringify(presentationBounds({ ...resolved.candidate, items: [] }))
        expect(canRestoreCamera(snapshot, bounds, 0)).toBe(true)
        expect(canRestoreCamera(snapshot, bounds, 1)).toBe(false)
        const actual = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...snapshot.quaternion))
        const desired = new Vector3(...shot.camera.target)
          .sub(new Vector3(...shot.camera.position))
          .normalize()
        expect(actual.distanceTo(desired)).toBeLessThan(1e-10)
        snapshot.position[0] = 999
        expect(
          seedFixtureCamera(resolved).current[shot.view === 'interior' ? 'interior' : 'exterior']!
            .position,
        ).toEqual(shot.camera.position)
      }
  })
  it('refuses an intentionally invalid candidate rather than rendering a repaired config', () => {
    const resolved = inspectFixture('VF04')
    expect(() =>
      seedFixtureCamera({ ...resolved, inspection: resolved.originalInspection }),
    ).toThrow('requires repair')
  })
})
