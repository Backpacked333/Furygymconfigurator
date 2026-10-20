import {
  AgXToneMapping,
  type DirectionalLight,
  RenderPipeline,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  type Camera,
  type Node,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  builtinAOContext,
  cameraFar,
  cameraNear,
  context,
  diffuseColor,
  float,
  interleavedGradientNoise,
  ivec2,
  int,
  max,
  metalness,
  min,
  mix,
  mrt,
  normalView,
  orthographicDepthToViewZ,
  output,
  packNormalToRGB,
  pass,
  perspectiveDepthToViewZ,
  positionView,
  renderOutput,
  roughness,
  sample,
  screenCoordinate,
  screenUV,
  smoothstep,
  textureLoad,
  toneMapping,
  uniform,
  unpackRGBToNormal,
  vec2,
  vec3,
  vec4,
  velocity,
  workingToColorSpace,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { ssr } from 'three/addons/tsl/display/SSRNode.js'
import { sss } from 'three/addons/tsl/display/SSSNode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js'
import { BLUR_SAMPLES, MAX_STREAK } from './motionBlur'
import type { Quality } from './renderer'
import { siteAmbient } from './siteLightNode'

export type Pipeline = {
  render: () => void
  warm: () => Promise<void>
  dispose: () => void
  /** Frames to keep rendering after a change so temporal AA, AO, and GI converge. */
  settleFrames: number
  /**
   * The motion blur's shutter (motionBlur.ts): 0.5 while the camera moves, 0 at rest, where the
   * frame is exactly the unblurred one. Null on Lite, which has no velocity buffer.
   */
  shutter: { value: number } | null
  /**
   * Where the camera stands, for the reach of the ambient occlusion (AO_REACH). Lite has none.
   */
  setPlace: (place: 'exterior' | 'interior') => void
}

/**
 * How far the ambient occlusion looks (its radius and depth thickness, feet). Outside, the light
 * from the sky is captured once, at the unit's centre (Atmosphere): a point at the foot of a
 * courtyard wall, under a tree or beside the unit has much of that sky taken by them, and only
 * a reach of the walls' own scale finds them on screen (at 0.9 ft, shade at a wall's foot read
 * more than a stop brighter than traced). Inside, the room's light is captured in the room
 * (InteriorProbe), its walls already in it: a long reach would count them twice.
 */
export const AO_REACH = { exterior: 4, interior: 0.9 } as const

/** A fraction of a level of noise against banding in smooth gradients (the sky). */
const dither = () =>
  interleavedGradientNoise(screenCoordinate.xy)
    .sub(0.5)
    .mul(1 / 255)

/**
 * Display-referred finishing: AgX tone mapping at the renderer's exposure, sRGB, and dither, as the
 * stills are finished (stillFinish). Named here rather than taken from the renderer: R3F's Canvas
 * sets ACES Filmic over the renderer's AgX when it first configures it, and ACES (which also
 * scales exposure by 1/0.6) made the live view about half a stop brighter and more saturated than
 * the stills. No vignette, as the stills have none.
 */
export function rasterFinish(hdr: Node<'vec4'>) {
  const display = renderOutput(hdr, AgXToneMapping, SRGBColorSpace)
  return vec4(display.rgb.add(dither()), 1)
}

/** View distances (ft) over which contact shadows fade from full strength to none. */
const CONTACT_NEAR = 20
const CONTACT_FAR = 45

/** The raster sun, tagged by the atmosphere. */
function findSun(scene: Scene) {
  let sun: DirectionalLight | null = null
  scene.traverse((object) => {
    if (object.userData.sun && (object as DirectionalLight).isDirectionalLight)
      sun = object as DirectionalLight
  })
  return sun as DirectionalLight | null
}

/**
 * Builds the TSL render pipeline for a quality tier. Every tier uses the same scene graph.
 *
 * - Lite: one 4x MSAA scene pass.
 * - High: depth/normal/velocity pre-pass, GTAO injected only into ambient light, sun contact
 *   shadows, temporal reprojection anti-aliasing, and the stills' bloom (STILL_BLOOM).
 * - Ultra: High plus screen-space global illumination (one diffuse bounce of on-screen light) and
 *   screen-space reflections on metals.
 */
export async function warmPipeline(renderer: WebGPURenderer, pipeline: RenderPipeline) {
  const render = renderer.render
  const compiles: Promise<unknown>[] = []
  renderer.render = ((scene: Scene, camera: Camera) => {
    compiles.push(renderer.compileAsync(scene, camera))
  }) as typeof renderer.render
  try {
    pipeline.render()
  } catch {
    // Unsupported passes compile on their first real frame instead.
  } finally {
    renderer.render = render
  }
  await Promise.allSettled(compiles)
}

/**
 * Screen-space passes a caller may switch off (or on) over its tier's own: Ultra has both, High
 * neither, and Lite, which has no pre-pass, ignores them. Unset, each follows the tier. The 360°
 * view's frame guard builds Ultra without them on a device that cannot keep up (viewer/frameGuard.ts).
 */
export type PipelineExtras = { reflections?: boolean; gi?: boolean }

export function createPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  quality: Quality,
  extras: PipelineExtras = {},
): Pipeline {
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const disposables: { dispose: () => void }[] = [pipeline]

  if (quality === 'lite') {
    const scenePass = pass(scene, camera, { samples: 4 })
    // No occlusion pass on Lite: the site's own light (siteLightNode.ts) still scales the ambient.
    scenePass.contextNode = builtinAOContext(siteAmbient())
    pipeline.outputNode = rasterFinish(scenePass)
    return {
      render: () => pipeline.render(),
      warm: () => warmPipeline(renderer, pipeline),
      // Scene passes own full-resolution render targets that the pipeline does not release.
      dispose: () => {
        pipeline.dispose()
        scenePass.dispose()
      },
      settleFrames: 1,
      shutter: null,
      setPlace: () => {},
    }
  }

  // Opaque geometry only: glazing must not occlude the interior in AO, GI, or reprojection.
  const prePass = pass(scene, camera)
  disposables.push(prePass)
  prePass.transparent = false
  const reflective = extras.reflections ?? quality === 'ultra'
  const bouncing = extras.gi ?? quality === 'ultra'
  prePass.setMRT(
    mrt(
      reflective
        ? {
            output: packNormalToRGB(normalView),
            velocity,
            metalrough: vec2(metalness, roughness),
          }
        : { output: packNormalToRGB(normalView), velocity },
    ),
  )
  prePass.getTexture('output').type = UnsignedByteType
  if (reflective) prePass.getTexture('metalrough').type = UnsignedByteType
  const preDepth = prePass.getTextureNode('depth')
  const preVelocity = prePass.getTextureNode('velocity')
  const preNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)))

  const occlusion = ao(preDepth, preNormal, camera)
  occlusion.resolutionScale = 0.5
  occlusion.radius.value = AO_REACH.exterior
  occlusion.thickness.value = AO_REACH.exterior
  occlusion.distanceExponent.value = 1.5
  occlusion.samples.value = 16
  disposables.push(occlusion)

  // Contact shadows: a short screen-space march toward the sun resolves the fine shadows a shadow
  // map spread over the whole site cannot (feet on the floor, a bench leg on paving, a plate on
  // its horn). They multiply the sun's shadow only, so lamps and sky light are untouched.
  let lighting = builtinAOContext(occlusion.getTextureNode().sample(screenUV).r.mul(siteAmbient()))
  let contactDebug: Node<'float'> | null = null
  const sun = findSun(scene)
  if (sun) {
    const contact = sss(preDepth, camera, sun)
    contact.maxDistance.value = 0.45
    contact.thickness.value = 0.08
    contact.quality.value = quality === 'ultra' ? 0.6 : 0.4
    contact.resolutionScale = quality === 'ultra' ? 1 : 0.5
    contact.useTemporalFiltering = true
    disposables.push(contact)
    // Full strength up close, gone by mid-distance: far away the depth buffer is too coarse to
    // tell contact from noise, and the site-wide shadow map already covers those scales.
    const contactAt = (viewZ: Node<'float'>) =>
      mix(
        float(1),
        contact.getTextureNode().sample(screenUV).r,
        smoothstep(CONTACT_FAR, CONTACT_NEAR, viewZ.negate()).mul(0.85),
      )
    const contactNode = contactAt(positionView.z)
    const toViewZ = (camera as PerspectiveCamera).isPerspectiveCamera
      ? perspectiveDepthToViewZ
      : orthographicDepthToViewZ
    contactDebug = contactAt(toViewZ(preDepth.sample(screenUV).r, cameraNear, cameraFar))
    // Glazing is not in the depth pre-pass, so what the march found belongs to the surface behind
    // it; its sun glints keep the shadow map alone.
    lighting = context(lighting, {
      getShadow: (
        { light, shadowColorNode }: { light: unknown; shadowColorNode: Node<'vec3'> },
        { material }: { material: { transparent: boolean } },
      ) =>
        light === sun && !material.transparent ? shadowColorNode.mul(contactNode) : shadowColorNode,
    })
  }
  const scenePass = pass(scene, camera)
  disposables.push(scenePass)
  scenePass.contextNode = lighting
  if (bouncing) scenePass.setMRT(mrt({ output, diffuseColor }))
  const color = scenePass.getTextureNode('output')

  let lit: Node<'vec4'> = color
  if (bouncing) {
    const diffuseTexture = scenePass.getTexture('diffuseColor')
    diffuseTexture.type = UnsignedByteType
    const gi = ssgi(color, preDepth, preNormal, camera as PerspectiveCamera)
    gi.sliceCount.value = 2
    gi.stepCount.value = 10
    gi.radius.value = 6
    gi.thickness.value = 0.6
    gi.giIntensity.value = 1.4
    disposables.push(gi)
    const bounce = scenePass.getTextureNode('diffuseColor').rgb.mul(gi.getGINode().rgb)
    lit = lit.add(vec4(bounce, 0))
  }

  let reflectionNode: Node<'vec4'> | null = null
  if (reflective) {
    // Screen-space reflections for metals and metallic-coated glass: chrome, brushed steel, and
    // facade windows reflect what is actually on screen, on top of their probe reflections.
    const metalRough = prePass.getTextureNode('metalrough')
    const reflections = ssr(color, preDepth, preNormal, {
      metalnessNode: metalRough.r,
      roughnessNode: metalRough.g,
      camera,
    })
    reflections.resolutionScale = 0.5
    reflections.maxDistance.value = 60
    reflections.thickness.value = 0.6
    reflections.intensity.value = 0.7
    disposables.push(reflections)
    reflectionNode = vec4(reflections.rgb, 1)
    lit = lit.add(vec4(reflections.rgb, 0))
  }

  const resolved = traa(lit, preDepth, preVelocity, camera)
  disposables.push(resolved)
  const resolvedTexture = (
    resolved as unknown as { getTextureNode: () => Node<'vec4'> }
  ).getTextureNode()
  // The stills' lens (STILL_BLOOM): a faint glow on whatever is brighter than its threshold, lamps
  // and sun glints and a sunlit white wall alike, so the room keeps the soft veil its stills have.
  const glow = bloom(
    resolvedTexture,
    STILL_BLOOM.strength,
    STILL_BLOOM.radius,
    STILL_BLOOM.threshold,
  )
  disposables.push(glow)
  // Motion blur, after the temporal resolve, along each pixel's own motion. three's velocity is the
  // offset in normalized device coordinates since the frame before (VelocityNode: current minus
  // previous clip xy / w, across -1..1 with y up); a texture coordinate runs across 0..1 with y
  // down, so a streak of the shutter's share of that motion is velocity × (0.5, -0.5) × shutter.
  const shutter = uniform(0)
  const motion = preVelocity.xy.mul(vec2(0.5, -0.5))
  const streak = motion.mul(shutter)
  const capped = streak.mul(min(float(1), float(MAX_STREAK).div(max(streak.length(), 1e-6))))
  // three r186's motionBlur adds its `n` taps to the centre one and divides by `n`, which brightens
  // the picture by 1/n while it moves; scaled back here (motionBlur.test.ts watches for a fix).
  const blurred = motionBlur(resolvedTexture, capped, int(BLUR_SAMPLES)).mul(
    BLUR_SAMPLES / (BLUR_SAMPLES + 1),
  )
  // At rest the shutter is exactly 0 and the frame is the resolved one untouched.
  const image = shutter.greaterThan(0).select(blurred, resolved)
  pipeline.outputNode = rasterFinish(image.add(vec4(glow.rgb, 0)))
  // `?debug=ao|normal|contact|reflections|motion` shows the occlusion, normal, contact-shadow,
  // screen-space reflection, or velocity buffer for tuning (motion: grey at rest, red for motion
  // to the right, green for motion up, full strength at a twentieth of the screen per frame).
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug === 'ao')
    pipeline.outputNode = vec4(vec3(occlusion.getTextureNode().sample(screenUV).r), 1)
  if (debug === 'normal')
    pipeline.outputNode = vec4(prePass.getTextureNode().sample(screenUV).rgb, 1)
  if (debug === 'contact' && contactDebug) pipeline.outputNode = vec4(vec3(contactDebug), 1)
  if (debug === 'reflections' && reflectionNode) pipeline.outputNode = rasterFinish(reflectionNode)
  if (debug === 'motion')
    pipeline.outputNode = vec4(motion.mul(vec2(10, -10)).add(0.5), float(0.5), 1)
  return {
    render: () => pipeline.render(),
    warm: () => warmPipeline(renderer, pipeline),
    dispose: () => disposables.forEach((d) => d.dispose()),
    // Screen-space GI, temporally filtered under TRAA, is the last pass to converge.
    settleFrames: bouncing ? 40 : 28,
    shutter,
    setPlace: (place) => {
      occlusion.radius.value = AO_REACH[place]
      occlusion.thickness.value = Math.max(1.2, AO_REACH[place])
    },
  }
}

export type StillFinish = {
  /** Finishes a traced HDR image (unfilterable float, rows top down) onto the canvas. */
  render: (image: Texture, exposure: number) => void
  dispose: () => void
}

/**
 * The cloud's bloom on a finished still (render-server finishing.py): a faint glow on what is
 * brighter than the threshold, as a lens records lamps and sun glints.
 */
export const STILL_BLOOM = { strength: 0.045, radius: 0.5, threshold: 2.4 } as const

/**
 * A still's finishing, as the render server finishes the cloud's (finishing.py): the bloom, AgX
 * tone mapping at the still's own exposure, sRGB, and a fraction of a level of dither. No
 * vignette: a still is the same photograph whether this device or the cloud traced it.
 */
export function stillFinish(hdr: Node<'vec4'>, exposure: Node<'float'>) {
  const glow = bloom(hdr, STILL_BLOOM.strength, STILL_BLOOM.radius, STILL_BLOOM.threshold)
  const bloomed = vec4(hdr.rgb.add(glow.rgb), 1)
  // The colour space node is untyped in three's typings; it keeps its input's type (vec4).
  const display = workingToColorSpace(
    toneMapping(AgXToneMapping, exposure, bloomed),
    SRGBColorSpace,
  ) as unknown as Node<'vec4'>
  return { output: vec4(display.rgb.add(dither()), 1), glow }
}

/**
 * Finishes this device's path-traced stills (stillFinish) for the canvas, where RenderEffects reads
 * them off as WebP, as the cloud's arrive.
 */
export function createStillFinish(renderer: WebGPURenderer, traced: Texture): StillFinish {
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const size = uniform(new Vector2(1, 1))
  const exposure = uniform(1)
  // Traced images are unfilterable float with rows top down, like screen coordinates.
  const image = textureLoad(traced, ivec2(screenUV.mul(size).floor()))
  const { output, glow } = stillFinish(vec4(image.rgb, 1), exposure)
  pipeline.outputNode = output
  return {
    render: (next, value) => {
      image.value = next
      const { width, height } = next.image as { width: number; height: number }
      size.value.set(width, height)
      exposure.value = value
      pipeline.render()
    },
    dispose: () => {
      glow.dispose()
      pipeline.dispose()
    },
  }
}
