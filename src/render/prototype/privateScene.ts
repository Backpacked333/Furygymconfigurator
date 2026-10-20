import { freezeDesignValue, parseDesign, projectDesignToConfig } from '../../domain/design'
import { resolveCamera } from '../../domain/presentation'
import { openingGeometry, productHeight } from '../../lib/config'
import { exposureAt, skyLook, sunBeam, STUDIO_AIM, STUDIO_SOFTBOXES } from '../../lib/visuals'
import { galleryCamera, composition, ASPECT_RATIO, type GalleryCamera } from '../gallery'
import { FLOOR_Y, interiorBounds } from '../envelope'
import { sceneryLayout } from '../scenery'
import { P03_REQUIRED_CONTROLS } from './p03Contract'

/** Camera-only identity checks must not repeatedly construct the entire scenery/light recipe. */
export function resolvePrivateThreeCamera(input: unknown) {
  const design = parseDesign(input)
  const config = projectDesignToConfig(design)
  const selected = resolveCamera(design.presentation.cameraRef)
  return {
    ...galleryCamera(config, selected.previewAngle, design.presentation.aspect),
    up: [0, 1, 0] as [0, 1, 0],
    near: 0.1 as const,
    far: 2000 as const,
    units: 'feet' as const,
  }
}

/** Native release 2 is independent of the historical G1/private-Three camera contract. */
export function resolveNativeCamera(input: unknown) {
  const design = parseDesign(input)
  const config = projectDesignToConfig(design)
  const selected = resolveCamera(design.presentation.cameraRef)
  let camera: GalleryCamera
  if (selected.ref === 'entry-draft@1' && config.family === 'container') {
    const opening = openingGeometry(config)
    const fov = design.presentation.aspect === 'wide' ? 60 : 76
    const tanV = Math.tan((fov * Math.PI) / 360)
    const distance = Math.max(
      5,
      (opening.width * 0.6) / (tanV * ASPECT_RATIO[design.presentation.aspect]),
      (productHeight(config) * 0.6) / tanV,
    )
    camera = {
      position: [opening.center, FLOOR_Y + 4.5, 4 + distance],
      target: [opening.center, FLOOR_Y + 3.2, -2.5],
      fov,
    }
  } else if (selected.ref === 'entry-draft@1') {
    const bounds = interiorBounds(config)
    const candidates = [1, -1].map((side): GalleryCamera => ({
      position: [
        side * (bounds.halfWidth - 0.55),
        Math.min(FLOOR_Y + 5.6, bounds.ceiling - 0.8),
        bounds.front - 0.65,
      ],
      target: [0, FLOOR_Y + 3.2, bounds.back * 0.45],
      fov: design.presentation.aspect === 'wide' ? 64 : 86,
    }))
    const score = (view: GalleryCamera) => {
      const seen = composition(config, view, design.presentation.aspect)
      return seen.subject - 2 * seen.crowding - seen.intrusion - seen.empty
    }
    camera = candidates.sort((a, b) => score(b) - score(a))[0]
  } else camera = galleryCamera(config, selected.previewAngle, design.presentation.aspect)
  return {
    ...camera,
    up: [0, 1, 0] as [0, 1, 0],
    near: 0.1 as const,
    far: 2000 as const,
    units: 'feet' as const,
  }
}

/** Pure reconstruction recipe shared by Node preparation and the owned private Three worker. */
export function resolvePrivateThreeSceneInput(input: unknown) {
  const design = parseDesign(input)
  const config = projectDesignToConfig(design)
  const selected = resolveCamera(design.presentation.cameraRef)
  const sky = skyLook(config.environment, config.time)
  const camera = resolvePrivateThreeCamera(design)
  return freezeDesignValue({
    contract: 'fury.private-three-scene-input@1' as const,
    design,
    config,
    view: selected.group,
    camera,
    aspectRatio: ASPECT_RATIO[design.presentation.aspect],
    profile: {
      quality: 'lite' as const,
      pipeline: 'three-tsl-raster-lite',
      colorSpace: 'srgb',
      toneMapping: 'AgX',
      pixelRatio: 1,
      msaaSamples: 4,
      width: design.presentation.aspect === 'wide' ? 640 : 400,
      height: design.presentation.aspect === 'wide' ? 400 : 500,
    },
    environment: {
      id: config.environment,
      scenery: sceneryLayout(config.environment, config.length),
      sky,
      sunBeam: sunBeam(sky),
      studioSoftboxes: config.environment === 'studio' ? STUDIO_SOFTBOXES : [],
      studioAim: STUDIO_AIM,
      reconstruction: ['Atmosphere', 'Landscape', 'Surroundings', 'SiteProbe'],
      seedPolicy: 'authored-scenery-seeds-and-lib-visuals-noise; no-random-placement',
    },
    lighting: {
      lookRef: design.presentation.lookRef,
      time: config.time,
      fixturesOn: config.lights,
      exposure: exposureAt(config.time)[selected.group],
      interiorStyle: config.interiorStyle,
      reconstruction: ['Atmosphere', 'StudioModel/InteriorLights', 'InteriorProbe', 'SiteProbe'],
      photometry: 'authored-scene-units-not-photometrically-qualified',
    },
    controls: P03_REQUIRED_CONTROLS.map((control) => ({
      control,
      consumer:
        control === 'camera' || control === 'aspect'
          ? 'private-worker/PerspectiveCamera'
          : control === 'environment' || control === 'lightingLook'
            ? 'private-worker/CaptureAssembly/Atmosphere+Landscape+StudioModel+Probes'
            : 'private-worker/CaptureAssembly/StudioModel',
    })),
    deferred: [
      'Real TSL materials, canvas pixels, fixtures, vegetation and probes reconstruct only in the owned renderer, not in CPU material holders.',
      'Lite mirror and thin glass are approximations; no path tracing or dedicated mirror reflection.',
      'Generic sans-serif console/signature fonts require pinned font bytes and mapping before cross-host pixel reproducibility.',
      'Cycles/Unreal require separately validated geometry/material/light/axis conversion.',
    ],
  })
}
export type PrivateThreeSceneInput = ReturnType<typeof resolvePrivateThreeSceneInput>

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value)
  throw new Error('Invalid private scene value.')
}

/** Recompute every derived field; supplied geometry, settings, paths and extra keys never win. */
export function validatePrivateThreeSceneInput(input: unknown): PrivateThreeSceneInput {
  if (input === null || typeof input !== 'object' || !('design' in input))
    throw new Error('Missing private scene design.')
  const expected = resolvePrivateThreeSceneInput(input.design)
  if (stable(input) !== stable(expected)) throw new Error('Private scene reconstruction mismatch.')
  return expected
}
