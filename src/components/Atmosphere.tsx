import { useLayoutEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
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
import {
  CLOUD_LAYER,
  SKY_SCALE,
  STUDIO_AIM,
  STUDIO_BACKDROP,
  STUDIO_SOFTBOXES,
  SUN_INTENSITY,
  nightAt,
  skyLook,
  sunlightAt,
  SKY_PRESETS,
  type SkyLook,
} from '../lib/visuals'
import type { Quality } from '../render/quality'
import { useResource } from '../render/useResource'
import { foliageDaylight } from '../render/vegetation'

/** Half-width of the sun's shadow map in feet, and how far toward the sun it gathers casters. */
const SHADOW_EXTENT = 64
const SHADOW_REACH = 420
/** A camera inside meters the dimmer room: roughly +2/3 stop, like a photographer would. */
export const INTERIOR_EXPOSURE = 1.6

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
    const look = skyLook(environment, time)
    configureSky(background, look)
    configureSky(capture.sky, look)
    foliageDaylight.value = Math.min(1, look.sunlight.intensity / 0.6)
    ;(capture.ground.material as MeshBasicMaterial).color.setRGB(...look.ground)
    if (environment === 'studio') {
      scene.background = null
      scene.backgroundNode = mix(color('#a9a59c'), color('#e7e3db'), screenUV.y.oneMinus().pow(0.8))
      scene.fog = new Fog(new Color('#d6d2ca'), 90, 420)
    } else {
      scene.backgroundNode = null
      scene.fog = new Fog(new Color(...look.fog), 70, 520)
    }
    if (generator) {
      target.current = generator.fromScene(
        environment === 'studio' ? capture.studio : capture.envScene,
        0,
        0.5,
        2000,
        { size: quality === 'lite' ? 128 : 256, renderTarget: target.current ?? undefined },
      )
      scene.environment = target.current.texture
    }
    scene.environmentIntensity = environment === 'studio' ? 0.9 : 1
    invalidate()
  }, [background, capture, environment, time, quality, generator, scene, invalidate])

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
  const sunlight = sunlightAt(config.time, preset)
  const night = nightAt(config.time)
  // The map covers the site and the ground around it in view, and reaches far enough toward the
  // sun that surrounding buildings and trees shade the site at low sun, as they do when traced.
  const extent = Math.max(config.length / 2 + 14, SHADOW_EXTENT)
  const distance = SHADOW_REACH
  const depth = SHADOW_REACH * 2
  const [x, y, z] = sunlight.direction
  return (
    <>
      <directionalLight
        // The path tracer replaces it with a sun disc of true angular size.
        userData={{ pathTrace: false }}
        position={[x * distance, Math.max(y, 0.02) * distance, z * distance]}
        color={new Color(...sunlight.color)}
        intensity={SUN_INTENSITY * sunlight.intensity}
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
      {night > 0.01 && (
        <directionalLight
          position={[-30, 60, 40]}
          color="#9db4ff"
          intensity={0.18 * night}
          castShadow={false}
        />
      )}
    </>
  )
}
