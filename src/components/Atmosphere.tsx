import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import {
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu'
import { PMREMGenerator, type RenderTarget } from 'three/webgpu'
import { color, mix, screenUV, vec4 } from 'three/tsl'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import type { Config } from '../lib/config'
import {
  SKY_PRESETS,
  horizonRadiance,
  nightAt,
  skyRadiance,
  sunlightAt,
  type Vec3,
} from '../lib/visuals'
import type { Quality } from '../render/renderer'

/**
 * three's Preetham sky is calibrated for a ~0.5 exposure with a 60,000-unit sun disc. Scaling its
 * radiance down puts clear-sky illuminance at roughly 1/3.5 of direct sun, as measured outdoors.
 */
const SKY_SCALE = 0.1
const SUN_INTENSITY = 4.2
const CLOUDS = { courtyard: 0.32, desert: 0.12, studio: 0 }

function configureSky(sky: SkyMesh, config: Config, sun: Vec3) {
  const preset = SKY_PRESETS[config.environment]
  sky.turbidity.value = preset.turbidity
  sky.rayleigh.value = preset.rayleigh
  sky.mieCoefficient.value = preset.mieCoefficient
  sky.mieDirectionalG.value = preset.mieDirectionalG
  sky.sunPosition.value.set(...sun)
  sky.cloudCoverage.value = CLOUDS[config.environment]
  sky.cloudDensity.value = 0.55
  sky.cloudScale.value = 0.00018
  sky.cloudSpeed.value = 0
  sky.cloudElevation.value = 0.55
}

function createSky(sunDisc: boolean) {
  const sky = new SkyMesh()
  const radiance = sky.material.colorNode as Node<'vec4'>
  sky.material.colorNode = vec4(radiance.rgb.mul(SKY_SCALE), 1)
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
  const room = new Mesh(
    new SphereGeometry(40, 32, 16),
    new MeshBasicMaterial({ color: new Color(0.42, 0.41, 0.39), side: BackSide }),
  )
  scene.add(room)
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

export function Atmosphere({ config, quality }: { config: Config; quality: Quality }) {
  const { gl, scene, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const preset = SKY_PRESETS[config.environment]
  const sunlight = sunlightAt(config.time, preset)
  const night = nightAt(config.time)
  const studio = config.environment === 'studio'

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
  const pmrem = useRef<{ generator: PMREMGenerator; target: RenderTarget | null } | null>(null)

  useEffect(() => {
    pmrem.current = { generator: new PMREMGenerator(renderer), target: null }
    return () => {
      pmrem.current?.target?.dispose()
      pmrem.current?.generator.dispose()
      pmrem.current = null
      scene.environment = null
    }
  }, [renderer, scene])

  // Sky, fog, and the image-based lighting captured from them, keyed to time and surroundings.
  useLayoutEffect(() => {
    const sun = sunlight.direction
    configureSky(background, config, sun)
    configureSky(capture.sky, config, sun)
    const groundAlbedo = config.environment === 'desert' ? [0.42, 0.34, 0.25] : [0.2, 0.23, 0.15]
    const sky = skyRadiance([0, 1, 0], sun, preset).map((v) => v * SKY_SCALE)
    const direct = (SUN_INTENSITY * sunlight.intensity * Math.max(0, sun[1])) / Math.PI
    ;(capture.ground.material as MeshBasicMaterial).color.setRGB(
      ...(groundAlbedo.map((a, i) => a * (direct * sunlight.color[i] + sky[i] * Math.PI)) as Vec3),
    )
    const horizon = horizonRadiance(sun, preset).map((v) => v * SKY_SCALE) as Vec3
    if (studio) {
      scene.background = null
      scene.backgroundNode = mix(color('#a9a59c'), color('#e7e3db'), screenUV.y.oneMinus().pow(0.8))
      scene.fog = new Fog(new Color('#d6d2ca'), 90, 420)
    } else {
      scene.backgroundNode = null
      const fogColor = new Color(...horizon)
      scene.fog = new Fog(fogColor, 120, 900)
    }
    const generator = pmrem.current?.generator
    if (generator) {
      const previous = pmrem.current!.target
      const target = generator.fromScene(studio ? capture.studio : capture.envScene, 0, 0.5, 2000, {
        size: quality === 'lite' ? 128 : 256,
        renderTarget: previous ?? undefined,
      })
      pmrem.current!.target = target
      scene.environment = target.texture
    }
    scene.environmentIntensity = studio ? 0.9 : 1
    // Eyes adapt after dark: lift exposure as the sky dims so lit interiors read naturally.
    renderer.toneMappingExposure = 1 + night * 1.35
    invalidate()
  }, [
    background,
    capture,
    config,
    preset,
    quality,
    renderer,
    scene,
    studio,
    sunlight.color,
    sunlight.direction,
    sunlight.intensity,
    night,
    invalidate,
  ])

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
  const light = useRef<DirectionalLight>(null)
  const extent = config.length / 2 + 14
  const distance = 80
  const [x, y, z] = sunlight.direction
  return (
    <>
      <directionalLight
        ref={light}
        position={[x * distance, Math.max(y, 0.02) * distance, z * distance]}
        color={new Color(...sunlight.color)}
        intensity={SUN_INTENSITY * sunlight.intensity}
        castShadow={quality !== 'lite' || config.environment !== 'studio'}
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
