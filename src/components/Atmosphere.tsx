import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BackSide,
  Color,
  Fog,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  type LightShadow,
  type Node,
  type Object3D,
  type RenderTarget,
  type Texture,
  type UniformNode,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  cameraPosition,
  color,
  float,
  mix,
  normalize,
  pmremTexture,
  positionWorld,
  screenUV,
  uniform,
  vec4,
} from 'three/tsl'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import type { Config, View } from '../lib/config'
import {
  CLOUD_LAYER,
  SKY_SCALE,
  STUDIO_AIM,
  STUDIO_BACKDROP,
  STUDIO_SOFTBOXES,
  exposureAt,
  nightAt,
  skyLook,
  sunBeam,
  type SkyLook,
} from '../lib/visuals'
import { circumsolarCut, circumsolarKeep, withoutCircumsolar } from '../render/circumsolar'
import { onMaterialsChanged } from '../render/materials'
import type { Quality } from '../render/quality'
import { FRAME_ENVIRONMENT } from '../render/renderer'
import { shadowOnly } from '../render/shadowOnly'
import { invalidateShadows } from '../render/shadows'
import { useResource } from '../render/useResource'
import { foliageDaylight } from '../render/vegetation'

/** Half-width of the sun's shadow map in feet, and how far toward the sun it gathers casters. */
const SHADOW_EXTENT = 64
const SHADOW_REACH = 420
/**
 * Daylight haze as the stills have it: next to none at the site's scale. Linear fog that matches
 * Beer–Lambert extinction over a 20 km (66,000 ft) visibility to first order: 3 % at 500 ft. The
 * traced stills have no fog at all; the old 70–520 ft fog pulled the courtyard's buildings halfway
 * to the horizon colour, a haze real daylight has only miles out.
 */
const HAZE_FAR = 66_000 / 3.912
/** Beyond the ground plane's edge (350 ft out) the stills see the sky map's ground: so does this. */
const HORIZON_RADIUS = 700
/**
 * The live view's image-based light is captured from the site itself, at the unit's centre and a
 * standing eye's height, looking through the unit: the courtyard's walls, trees and paving hide
 * part of the sky and bounce sunlight back, as they do for the traced stills. Lit by the open sky
 * alone, shaded paving and facades were a stop or more too bright and far too blue. The unit still
 * casts its shadow in the capture: the paving it shades bounces no sunlight onto it.
 */
const SITE_POINT = new Vector3(0, 5, 0)
/** Captures per change, each lit by the one before: the second carries a bounce of the first. */
const SITE_PASSES = 2
/** Changes arriving faster than this (a slider drag, scans streaming in) are captured once. */
const SITE_DEBOUNCE_MS = 300

/** Glazing: the capture looks through it, as the probes do (InteriorProbe). */
const isGlazing = (object: Object3D) => {
  const surface = (object as Mesh).material as
    { transmission?: number; userData?: { glass?: boolean } } | undefined
  return (surface?.transmission ?? 0) > 0 || !!surface?.userData?.glass
}

function configureSky(sky: Sky, look: SkyLook) {
  const { preset } = look
  sky.fill.value.setRGB(...look.fill)
  sky.turbidity.value = preset.turbidity
  sky.rayleigh.value = preset.rayleigh
  sky.mieCoefficient.value = preset.mieCoefficient
  sky.mieDirectionalG.value = preset.mieDirectionalG
  sky.sunPosition.value.set(...look.sunlight.direction)
  sky.cloudCoverage.value = look.clouds.coverage
  sky.cloudDensity.value = CLOUD_LAYER.density
  sky.cloudScale.value = CLOUD_LAYER.scale
  sky.cloudSpeed.value = 0
  sky.cloudElevation.value = CLOUD_LAYER.elevation
}

type Sky = SkyMesh & { fill: UniformNode<'color', Color> }

/**
 * A sky. `cut` at 1 leaves the circumsolar glow out of it (circumsolar.ts): always for the sky
 * the open-sky capture sees, only while a capture is taken for the sky seen in the view.
 */
function createSky(sunDisc: boolean, cut: Node<'float'>): Sky {
  const sky = new SkyMesh() as Sky
  const radiance = sky.material.colorNode as Node<'vec4'>
  sky.fill = uniform(new Color(0, 0, 0))
  const view = normalize(positionWorld.sub(cameraPosition))
  const up = view.y.clamp(0, 1).pow(0.6)
  const keep = circumsolarKeep(view, sky.sunPosition, cut)
  sky.material.colorNode = vec4(radiance.rgb.mul(SKY_SCALE).add(sky.fill.mul(up)).mul(keep), 1)
  // A tiny 6000-unit disc would only add fireflies to the filtered environment; the directional
  // light already carries the sun.
  sky.showSunDisc.value = sunDisc ? 1 : 0
  sky.scale.setScalar(1500)
  sky.frustumCulled = false
  sky.renderOrder = -1
  // The path tracer lights and backs the scene with an HDR map of this same sky.
  sky.userData.pathTrace = false
  return sky
}

/** Photo-studio light rig: overhead and side softboxes in a neutral cyclorama. */
function studioScene() {
  const scene = new Scene()
  scene.add(
    new Mesh(
      new SphereGeometry(40, 32, 16),
      new MeshBasicMaterial({ color: new Color(...STUDIO_BACKDROP), side: BackSide }),
    ),
  )
  const softbox = (w: number, h: number, intensity: number, x: number, y: number, z: number) => {
    const panel = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ color: new Color(intensity, intensity * 0.98, intensity * 0.94) }),
    )
    panel.position.set(x, y, z)
    panel.lookAt(...STUDIO_AIM)
    scene.add(panel)
  }
  for (const box of STUDIO_SOFTBOXES) softbox(...box)
  return scene
}

export function Atmosphere({
  config,
  quality,
  view,
}: {
  config: Config
  quality: Quality
  view: View
}) {
  const { gl, scene, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const { environment, time } = config
  const studio = environment === 'studio'

  const background = useMemo(() => createSky(true, circumsolarCut), [])
  // The ground the traced stills see past the paving's edge (visuals.ts environmentRadiance, below
  // the horizon), so the raster's horizon meets the sky as theirs does.
  const horizon = useMemo(() => {
    const mesh = new Mesh(
      new SphereGeometry(HORIZON_RADIUS, 48, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new MeshBasicMaterial({ side: BackSide, fog: false }),
    )
    mesh.userData.pathTrace = false
    mesh.frustumCulled = false
    return mesh
  }, [])
  const capture = useMemo(() => {
    const envScene = new Scene()
    const sky = createSky(false, float(1))
    const ground = new Mesh(
      new SphereGeometry(900, 48, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new MeshBasicMaterial({ side: BackSide }),
    )
    envScene.add(sky, ground)
    return { envScene, sky, ground, studio: studioScene() }
  }, [])
  const generator = useResource(() => new PMREMGenerator(renderer), [renderer])
  /** The open sky's capture, and the site's two, taken in turns (one is lit by the other). */
  const target = useRef<RenderTarget | null>(null)
  const site = useRef({
    targets: [null, null] as (RenderTarget | null)[],
    current: 0,
    passes: 0,
    due: 0,
  })
  // The scene's light, as a node whose texture is swapped in place: a new environment texture
  // would give every lit material a new shader.
  const environmentNode = useRef<ReturnType<typeof pmremTexture> | null>(null)
  const wake = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const environmentStale = useRef(true)
  // One fog object, updated in place: a new one would give every material a new fog node.
  const fog = useMemo(() => new Fog(new Color(), 70, 520), [])
  // Built once, so a change in the studio backdrop does not hand the background a new shader.
  const backdrop = useMemo(
    () => mix(color('#a9a59c'), color('#e7e3db'), screenUV.y.oneMinus().pow(0.8)),
    [],
  )
  // A layout effect, declared before the capture below, so the previous generator's target is
  // released before (never after) the new one is captured.
  useLayoutEffect(
    () => () => {
      target.current?.dispose()
      target.current = null
      site.current.targets.forEach((t) => t?.dispose())
      site.current = { targets: [null, null], current: 0, passes: 0, due: 0 }
      clearTimeout(wake.current)
      environmentNode.current = null
      scene.environment = null
      scene.environmentNode = null
    },
    [generator, scene],
  )
  const setEnvironment = useCallback(
    (texture: Texture) => {
      if (environmentNode.current) environmentNode.current.value = texture
      else {
        environmentNode.current = pmremTexture(texture)
        scene.environmentNode = environmentNode.current
      }
    },
    [scene],
  )
  /** The site's light is captured again once changes stop arriving (`SITE_DEBOUNCE_MS`). */
  const recaptureSite = useCallback(() => {
    site.current.passes = SITE_PASSES
    site.current.due = performance.now() + SITE_DEBOUNCE_MS
    clearTimeout(wake.current)
    wake.current = setTimeout(invalidate, SITE_DEBOUNCE_MS + 1)
  }, [invalidate])
  // What the site looks like changes with its scans arriving and with the unit's length, which
  // moves the buildings around it.
  useEffect(
    () =>
      onMaterialsChanged((change) => {
        if (change === 'textures') recaptureSite()
      }),
    [recaptureSite],
  )
  useEffect(() => recaptureSite(), [config.length, config.family, recaptureSite])

  // Sky, fog, and the image-based lighting captured from them, keyed to time and surroundings.
  useLayoutEffect(() => {
    const look = skyLook(environment, time)
    configureSky(background, look)
    configureSky(capture.sky, look)
    // No glow of light through the leaves: the stills trace them as plain cards, whose shaded
    // inner leaves are dark, and a raster leaf that glowed in shade read 1.5 stops brighter.
    foliageDaylight.value = 0
    ;(capture.ground.material as MeshBasicMaterial).color.setRGB(...look.ground)
    ;(horizon.material as MeshBasicMaterial).color.setRGB(...look.ground)
    if (environment === 'studio') {
      scene.background = null
      scene.backgroundNode = backdrop
      fog.color.set('#d6d2ca')
      fog.near = 90
      fog.far = 420
    } else {
      scene.backgroundNode = null
      fog.color.setRGB(...look.fog)
      fog.near = 0
      fog.far = HAZE_FAR
    }
    scene.fog = fog
    scene.environmentIntensity = environment === 'studio' ? 0.9 : 1
    environmentStale.current = true
    invalidate()
  }, [
    background,
    capture,
    horizon,
    environment,
    time,
    quality,
    generator,
    scene,
    fog,
    backdrop,
    invalidate,
  ])

  // The image-based lighting is captured at the start of the next frame, for the latest settings,
  // rather than on every change: a time-of-day drag can commit several changes between frames.
  // The open sky first, at once; outside, the site's own a moment later, lit by it.
  useFrame(() => {
    if (!generator) return
    const size = quality === 'lite' ? 128 : 256
    // A target is reused only at its own cube size; Lite and High/Ultra differ.
    const sized = (t: RenderTarget | null) => {
      if (t && t.height !== 4 * size) {
        t.dispose()
        return null
      }
      return t
    }
    if (environmentStale.current) {
      environmentStale.current = false
      target.current = generator.fromScene(
        studio ? capture.studio : capture.envScene,
        0,
        0.5,
        2000,
        { size, renderTarget: sized(target.current) ?? undefined },
      )
      setEnvironment(target.current.texture)
      if (studio) site.current.passes = 0
      else recaptureSite()
      return
    }
    const state = site.current
    if (state.passes <= 0 || performance.now() < state.due) return
    // Taken as the probes take theirs, through glazing and without the sun disc (the sun light
    // carries the sun), the shadow maps drawn once for it; the unit is drawn as nothing but its
    // shadow.
    const hidden: Object3D[] = []
    const restores: (() => void)[] = []
    const shadows: { shadow: LightShadow; autoUpdate: boolean }[] = []
    const discs: { uniform: { value: number }; value: number }[] = []
    scene.traverse((object) => {
      const disc = (object as Object3D & { showSunDisc?: { value: number } }).showSunDisc
      if (disc) {
        discs.push({ uniform: disc, value: disc.value })
        disc.value = 0
      }
      if (object.userData.unit === true) restores.push(shadowOnly(object))
      else if (isGlazing(object) && object.visible) {
        object.visible = false
        hidden.push(object)
      }
      const light = object as Object3D & { isLight?: boolean; castShadow?: boolean }
      const shadow = (light as { shadow?: LightShadow }).shadow
      if (light.isLight && light.castShadow && shadow) {
        shadows.push({ shadow, autoUpdate: shadow.autoUpdate })
        shadow.autoUpdate = false
        shadow.needsUpdate = true
      }
    })
    const next = 1 - state.current
    let captured: RenderTarget
    try {
      captured = withoutCircumsolar(() =>
        generator.fromScene(scene, 0, 0.5, 2000, {
          size,
          position: SITE_POINT,
          renderTarget: sized(state.targets[next]) ?? undefined,
        }),
      )
    } finally {
      hidden.forEach((object) => (object.visible = true))
      restores.forEach((restore) => restore())
      shadows.forEach(({ shadow, autoUpdate }) => (shadow.autoUpdate = autoUpdate))
      discs.forEach(({ uniform, value }) => (uniform.value = value))
    }
    state.targets[next] = captured
    state.current = next
    state.passes--
    setEnvironment(captured.texture)
    // Its shadow maps were drawn for the capture: the view draws its own again.
    invalidateShadows(scene)
    invalidate()
  }, FRAME_ENVIRONMENT)

  // The stills' exposure (visuals.ts exposureAt): eyes adapt after dark, and a camera inside
  // opens up for the dimmer room.
  useLayoutEffect(() => {
    const exposure = exposureAt(time)
    renderer.toneMappingExposure = view === 'interior' ? exposure.interior : exposure.exterior
    invalidate()
  }, [renderer, time, view, invalidate])

  return (
    <>
      {!studio && <primitive object={background} />}
      {!studio && <primitive object={horizon} />}
      <SunLight config={config} quality={quality} />
    </>
  )
}

function SunLight({ config, quality }: { config: Config; quality: Quality }) {
  const look = useMemo(
    () => skyLook(config.environment, config.time),
    [config.environment, config.time],
  )
  const { sunlight } = look
  const night = nightAt(config.time)
  // The map covers the site and the ground around it in view, and reaches far enough toward the
  // sun that surrounding buildings and trees shade the site at low sun, as they do when traced.
  const extent = Math.max(config.length / 2 + 14, SHADOW_EXTENT)
  const distance = SHADOW_REACH
  const depth = SHADOW_REACH * 2
  const [x, y, z] = sunlight.direction
  // The sun's beam and the circumsolar sky's (visuals.ts sunBeam): what shades a surface from the
  // sun shades it from the glow around it too, as the traced stills find.
  const beam = useMemo(() => sunBeam(look), [look])
  const peak = Math.max(...beam, 1e-6)
  const [r, g, b] = beam.map((v) => v / peak)
  // A new Color on every render would read as a changed prop and restart the settle frames even
  // when nothing visible changed (a panel tab, a toast).
  const sunColor = useMemo(() => new Color(r, g, b), [r, g, b])
  return (
    <>
      <directionalLight
        // The path tracer replaces it with a sun disc of true angular size; the raster pipeline
        // finds it to add contact shadows.
        userData={{ pathTrace: false, sun: true }}
        position={[x * distance, Math.max(y, 0.02) * distance, z * distance]}
        color={sunColor}
        intensity={peak}
        castShadow
        shadow-mapSize={quality === 'lite' ? [2048, 2048] : [4096, 4096]}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        shadow-camera-near={10}
        shadow-camera-far={depth}
        // About 0.07 ft of depth bias whatever the depth range.
        shadow-bias={-0.07 / depth}
        shadow-normalBias={quality === 'lite' ? 0.05 : 0.03}
        shadow-radius={quality === 'lite' ? 2 : 4}
      />
      {/* Moonlight stays mounted (dark by day): adding or removing a light changes every lit
          material's shader, so crossing dusk on the time slider would recompile the scene. */}
      <directionalLight
        position={[-30, 60, 40]}
        color="#9db4ff"
        intensity={night > 0.01 ? 0.18 * night : 0}
        castShadow={false}
      />
    </>
  )
}
