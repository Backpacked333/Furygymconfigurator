import { useLayoutEffect, useMemo, useRef } from 'react'
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
  type Node,
  type RenderTarget,
  type UniformNode,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  cameraPosition,
  color,
  mix,
  normalize,
  positionWorld,
  screenUV,
  uniform,
  vec4,
} from 'three/tsl'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import type { Config, View } from '../lib/config'
import { sceneTime } from '../lib/lighting'
import {
  CLOUDS,
  GROUND_ALBEDO,
  NIGHT_SKY,
  SKY_PRESETS,
  horizonRadiance,
  nightAt,
  skyRadiance,
  sunlightAt,
  type Vec3,
} from '../lib/visuals'
import type { Quality } from '../render/quality'
import { FRAME_ENVIRONMENT } from '../render/renderer'
import { useResource } from '../render/useResource'
import { foliageDaylight } from '../render/vegetation'

/**
 * three's Preetham sky is calibrated for a ~0.5 exposure with a 60,000-unit sun disc. Scaling its
 * radiance down puts clear-sky illuminance at roughly 1/3.5 of direct sun, as measured outdoors.
 */
const SKY_SCALE = 0.13
/**
 * Preetham's single-scattering zenith is ~12x darker than its horizon; measured clear skies are
 * 2-4x. A fill proportional to the horizon stands in for multiple scattering, so dark glossy
 * finishes facing the sky reflect it as they do in photographs.
 */
const SKY_FILL = 0.12
const SUN_INTENSITY = 4.2
/** A camera inside meters the dimmer room: roughly +2/3 stop, like a photographer would. */
const INTERIOR_EXPOSURE = 1.6

type Environment = Config['environment']

function configureSky(sky: Sky, environment: Environment, sun: Vec3, night: number) {
  const preset = SKY_PRESETS[environment]
  const horizon = horizonRadiance(sun, preset)
  sky.fill.value.setRGB(
    ...(horizon.map(
      (v, i) => v * SKY_SCALE * SKY_FILL + NIGHT_SKY[environment][i] * night,
    ) as Vec3),
  )
  sky.turbidity.value = preset.turbidity
  sky.rayleigh.value = preset.rayleigh
  sky.mieCoefficient.value = preset.mieCoefficient
  sky.mieDirectionalG.value = preset.mieDirectionalG
  sky.sunPosition.value.set(...sun)
  sky.cloudCoverage.value = CLOUDS[environment]
  sky.cloudDensity.value = 0.55
  sky.cloudScale.value = 0.00018
  sky.cloudSpeed.value = 0
  sky.cloudElevation.value = 0.55
}

type Sky = SkyMesh & { fill: UniformNode<'color', Color> }

function createSky(sunDisc: boolean): Sky {
  const sky = new SkyMesh() as Sky
  const radiance = sky.material.colorNode as Node<'vec4'>
  sky.fill = uniform(new Color(0, 0, 0))
  const up = normalize(positionWorld.sub(cameraPosition)).y.clamp(0, 1).pow(0.6)
  sky.material.colorNode = vec4(radiance.rgb.mul(SKY_SCALE).add(sky.fill.mul(up)), 1)
  // A tiny 6000-unit disc would only add fireflies to the filtered environment; the directional
  // light already carries the sun.
  sky.showSunDisc.value = sunDisc ? 1 : 0
  sky.scale.setScalar(1500)
  sky.frustumCulled = false
  sky.renderOrder = -1
  return sky
}

/** Photo-studio light rig: overhead and side softboxes in a neutral cyclorama. */
function studioScene() {
  const scene = new Scene()
  scene.add(
    new Mesh(
      new SphereGeometry(40, 32, 16),
      new MeshBasicMaterial({ color: new Color(0.42, 0.41, 0.39), side: BackSide }),
    ),
  )
  const softbox = (w: number, h: number, intensity: number, x: number, y: number, z: number) => {
    const panel = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ color: new Color(intensity, intensity * 0.98, intensity * 0.94) }),
    )
    panel.position.set(x, y, z)
    panel.lookAt(0, 4, 0)
    scene.add(panel)
  }
  softbox(30, 22, 5.5, 0, 34, 6)
  softbox(10, 26, 3.2, -30, 12, 18)
  softbox(10, 26, 2.2, 32, 10, -6)
  softbox(40, 6, 1.6, 0, 6, 36)
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
  const { environment } = config
  const time = sceneTime(config)
  const studio = environment === 'studio'

  const background = useMemo(() => createSky(true), [])
  const capture = useMemo(() => {
    const envScene = new Scene()
    const sky = createSky(false)
    const ground = new Mesh(
      new SphereGeometry(900, 48, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new MeshBasicMaterial({ side: BackSide }),
    )
    envScene.add(sky, ground)
    return { envScene, sky, ground, studio: studioScene() }
  }, [])
  const generator = useResource(() => new PMREMGenerator(renderer), [renderer])
  const target = useRef<RenderTarget | null>(null)
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
      scene.environment = null
    },
    [generator, scene],
  )

  // Sky, fog, and the image-based lighting captured from them, keyed to time and surroundings.
  useLayoutEffect(() => {
    const preset = SKY_PRESETS[environment]
    const sunlight = sunlightAt(time, preset)
    const sun = sunlight.direction
    const night = nightAt(time)
    configureSky(background, environment, sun, night)
    configureSky(capture.sky, environment, sun, night)
    foliageDaylight.value = Math.min(1, sunlight.intensity / 0.6)
    const groundAlbedo = GROUND_ALBEDO[environment]
    const horizonFill = horizonRadiance(sun, preset).map((v) => v * SKY_SCALE * SKY_FILL)
    const sky = skyRadiance([0, 1, 0], sun, preset).map(
      (v, i) => v * SKY_SCALE + horizonFill[i] + NIGHT_SKY[environment][i] * night,
    )
    const direct = (SUN_INTENSITY * sunlight.intensity * Math.max(0, sun[1])) / Math.PI
    ;(capture.ground.material as MeshBasicMaterial).color.setRGB(
      ...(groundAlbedo.map((a, i) => a * (direct * sunlight.color[i] + sky[i] * Math.PI)) as Vec3),
    )
    if (environment === 'studio') {
      scene.background = null
      scene.backgroundNode = backdrop
      fog.color.set('#d6d2ca')
      fog.near = 90
      fog.far = 420
    } else {
      scene.backgroundNode = null
      fog.color.setRGB(...(horizonRadiance(sun, preset).map((v) => v * SKY_SCALE) as Vec3))
      fog.near = 70
      fog.far = 520
    }
    scene.fog = fog
    scene.environmentIntensity = environment === 'studio' ? 0.9 : 1
    environmentStale.current = true
    invalidate()
  }, [background, capture, environment, time, quality, generator, scene, fog, backdrop, invalidate])

  // The image-based lighting is captured at the start of the next frame, for the latest settings,
  // rather than on every change: a time-of-day drag can commit several changes between frames.
  useFrame(() => {
    if (!environmentStale.current || !generator) return
    environmentStale.current = false
    const size = quality === 'lite' ? 128 : 256
    // A target is reused only at its own cube size; Lite and High/Ultra differ.
    if (target.current && target.current.height !== 4 * size) {
      target.current.dispose()
      target.current = null
    }
    target.current = generator.fromScene(studio ? capture.studio : capture.envScene, 0, 0.5, 2000, {
      size,
      renderTarget: target.current ?? undefined,
    })
    scene.environment = target.current.texture
  }, FRAME_ENVIRONMENT)

  // Eyes adapt after dark, and a camera inside meters for the dimmer room.
  useLayoutEffect(() => {
    renderer.toneMappingExposure =
      (1 + nightAt(time) * 1.35) * (view === 'interior' ? INTERIOR_EXPOSURE : 1)
    invalidate()
  }, [renderer, time, view, invalidate])

  return (
    <>
      {!studio && <primitive object={background} />}
      <SunLight config={config} quality={quality} />
    </>
  )
}

function SunLight({ config, quality }: { config: Config; quality: Quality }) {
  const preset = SKY_PRESETS[config.environment]
  const time = sceneTime(config)
  const sunlight = sunlightAt(time, preset)
  const night = nightAt(time)
  const extent = config.length / 2 + 14
  const distance = 80
  const [x, y, z] = sunlight.direction
  const [r, g, b] = sunlight.color
  // A new Color on every render would read as a changed prop and restart the settle frames even
  // when nothing visible changed (a panel tab, a toast).
  const sunColor = useMemo(() => new Color(r, g, b), [r, g, b])
  return (
    <>
      <directionalLight
        position={[x * distance, Math.max(y, 0.02) * distance, z * distance]}
        color={sunColor}
        intensity={SUN_INTENSITY * sunlight.intensity}
        castShadow
        shadow-mapSize={quality === 'lite' ? [1024, 1024] : [4096, 4096]}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        shadow-camera-near={10}
        shadow-camera-far={180}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
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
