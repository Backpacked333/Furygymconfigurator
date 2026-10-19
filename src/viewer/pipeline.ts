import {
  RenderPipeline,
  UnsignedByteType,
  type Camera,
  type Node,
  type PerspectiveCamera,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  builtinAOContext,
  diffuseColor,
  emissive,
  float,
  interleavedGradientNoise,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  renderOutput,
  sample,
  screenCoordinate,
  screenUV,
  smoothstep,
  unpackRGBToNormal,
  vec3,
  vec4,
  velocity,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import type { TierSpec } from './tiers'

export type Pipeline = {
  render: () => void
  dispose: () => void
  /** Frames to keep rendering after a change so temporal AA, AO, and GI converge. */
  settleFrames: number
}

/** Display-referred finishing: filmic tone mapping, a soft lens vignette, and dither. */
function finish(hdr: Node<'vec4'>) {
  const display = renderOutput(hdr)
  const edge = screenUV.sub(0.5).length().mul(1.18)
  const vignette = mix(float(0.8), float(1), smoothstep(0.98, 0.32, edge))
  const dither = interleavedGradientNoise(screenCoordinate.xy)
    .sub(0.5)
    .mul(1 / 255)
  return vec4(display.rgb.mul(vignette).add(dither), 1)
}

/** One multisampled scene pass, finished for display. */
function direct(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  samples: number,
  scale?: number,
): Pipeline {
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const scenePass = pass(scene, camera, { samples })
  pipeline.outputNode = finish(scenePass)
  return {
    render: () => {
      // A fixed pixel ratio whatever the canvas's: the pass is upscaled to the screen.
      if (scale !== undefined)
        scenePass.setResolutionScale(Math.min(1, scale / renderer.getPixelRatio()))
      pipeline.render()
    },
    // Scene passes own full-resolution render targets that the pipeline does not release.
    dispose: () => {
      pipeline.dispose()
      scenePass.dispose()
    },
    settleFrames: 1,
  }
}

/**
 * The pipeline drawn while the camera moves: one pass at the tier's motion pixel ratio with light
 * multisampling. Its cost barely depends on the tier, so dragging is smooth on any device.
 */
export function createMotionPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  spec: TierSpec,
): Pipeline {
  return direct(renderer, scene, camera, spec.motion.samples, spec.motion.dpr)
}

/**
 * Builds the TSL render pipeline for a tier. Every tier uses the same scene graph.
 *
 * - No AO (Lite): one multisampled scene pass.
 * - AO (High): depth/normal/velocity pre-pass, GTAO injected only into ambient light, emissive
 *   bloom, temporal reprojection anti-aliasing.
 * - AO and GI (Ultra): High plus screen-space global illumination (one diffuse bounce).
 */
export function createPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  spec: TierSpec,
): Pipeline {
  if (!spec.ao) return direct(renderer, scene, camera, spec.samples)
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const disposables: { dispose: () => void }[] = [pipeline]

  // Opaque geometry only: glazing must not occlude the interior in AO, GI, or reprojection.
  const prePass = pass(scene, camera)
  disposables.push(prePass)
  prePass.transparent = false
  prePass.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }))
  prePass.getTexture('output').type = UnsignedByteType
  const preDepth = prePass.getTextureNode('depth')
  const preVelocity = prePass.getTextureNode('velocity')
  const preNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)))

  const occlusion = ao(preDepth, preNormal, camera)
  occlusion.resolutionScale = 0.5
  occlusion.radius.value = 0.9
  occlusion.thickness.value = 1.2
  occlusion.distanceExponent.value = 1.5
  occlusion.samples.value = spec.ao.samples
  disposables.push(occlusion)

  const scenePass = pass(scene, camera)
  disposables.push(scenePass)
  scenePass.contextNode = builtinAOContext(occlusion.getTextureNode().sample(screenUV).r)
  scenePass.setMRT(mrt(spec.gi ? { output, emissive, diffuseColor } : { output, emissive }))
  const color = scenePass.getTextureNode('output')
  const glow = bloom(scenePass.getTextureNode('emissive'), 0.55, 0.45, 0.05)
  disposables.push(glow)

  let lit: Node<'vec4'> = color.add(vec4(glow.rgb, 0))
  if (spec.gi) {
    const diffuseTexture = scenePass.getTexture('diffuseColor')
    diffuseTexture.type = UnsignedByteType
    const gi = ssgi(color, preDepth, preNormal, camera as PerspectiveCamera)
    gi.sliceCount.value = spec.gi.slices
    gi.stepCount.value = spec.gi.steps
    gi.radius.value = 6
    gi.thickness.value = 0.6
    gi.giIntensity.value = 1.4
    disposables.push(gi)
    const bounce = scenePass.getTextureNode('diffuseColor').rgb.mul(gi.getGINode().rgb)
    lit = lit.add(vec4(bounce, 0))
  }

  const resolved = traa(lit, preDepth, preVelocity, camera)
  disposables.push(resolved)
  pipeline.outputNode = finish(resolved)
  // `?debug=ao` shows the occlusion buffer for tuning.
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug === 'ao')
    pipeline.outputNode = vec4(vec3(occlusion.getTextureNode().sample(screenUV).r), 1)
  if (debug === 'normal')
    pipeline.outputNode = vec4(prePass.getTextureNode().sample(screenUV).rgb, 1)
  return {
    render: () => pipeline.render(),
    dispose: () => disposables.forEach((d) => d.dispose()),
    settleFrames: spec.settleFrames,
  }
}
