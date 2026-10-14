import { PerspectiveCamera, Vector3 } from 'three'
import { inspectDocument } from '../../lib/config'
import type { CameraMemoryRef } from '../../lib/camera'
import { presentationBounds } from '../../lib/spatial'
import { nightAt } from '../../lib/visuals'
import { resolveFixture, VISUAL_FIXTURES, type FixtureId } from './fixtures'

export function inspectFixture(id: FixtureId, shotId?: string) {
  const resolved = resolveFixture(id, shotId)
  return {
    ...resolved,
    inspection: inspectDocument(resolved.candidate),
    originalInspection: inspectDocument(resolved.originalCandidate),
  }
}

export function fixtureValidity() {
  return VISUAL_FIXTURES.flatMap((fixture) =>
    fixture.shots.map((shot) => {
      const result = inspectFixture(fixture.id, shot.id)
      return {
        fixture: fixture.id,
        shot: shot.id,
        status: result.inspection.status,
        issues: result.inspection.issues,
        originalStatus: result.originalInspection.status,
        originalIssues: result.originalInspection.issues,
        adjustments: result.candidateAdjustments,
        assetVersion: result.assetVersion,
      }
    }),
  )
}

export function seedFixtureCamera(resolved: ReturnType<typeof inspectFixture>): CameraMemoryRef {
  if (resolved.inspection.status !== 'accepted') throw new Error('Fixture requires repair')
  const { camera } = resolved.shot
  const view = resolved.shot.view === 'interior' ? 'interior' : 'exterior'
  const perspective = new PerspectiveCamera(camera.fov)
  perspective.position.fromArray(camera.position)
  perspective.lookAt(...camera.target)
  return {
    current: {
      [view]: {
        position: [...camera.position],
        target: [...camera.target],
        quaternion: perspective.quaternion.toArray(),
        fov: camera.fov,
        bounds: JSON.stringify(presentationBounds({ ...resolved.inspection.config, items: [] })),
        reset: 0,
      },
    },
  }
}

export function fixtureScenePolicy(resolved: ReturnType<typeof inspectFixture>) {
  const { camera, view, time } = resolved.shot
  const distance = new Vector3(...camera.position).distanceTo(new Vector3(...camera.target))
  return {
    exposureExpectedFromProductionPolicy:
      (1 + nightAt(time) * 1.35) * (view === 'interior' ? 1.6 : 1),
    exposureMeasurement: 'Derived from Atmosphere policy at the asset revision; not GPU telemetry',
    clipping: { near: 0.1, far: 2000 },
    cameraSeedDistance: distance,
    orbitConstraintWarning:
      view !== 'interior' && (distance < 12 || distance > 170)
        ? 'Authored exterior camera distance is outside production OrbitControls 12–170ft limits. The exact seed may be clamped; compare the actual camera memory/token before scoring crops. Production camera code is unchanged.'
        : null,
  }
}
