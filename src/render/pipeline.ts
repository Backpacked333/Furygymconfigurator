import {
  RenderPipeline,
  RendererUtils,
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
  rtt,
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
import type { Quality } from './renderer'
import { createDisposalScope } from '../lib/presentation'

export type Pipeline = {
  render: () => void
  dispose: () => void
  resetHistory: () => void
  resize: (width: number, height: number) => void
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

/**
 * Builds the TSL render pipeline for a quality tier. Every tier uses the same scene graph.
 *
 * - Lite: one 4x MSAA scene pass.
 * - High: depth/normal/velocity pre-pass, GTAO injected only into ambient light, emissive bloom,
 *   temporal reprojection anti-aliasing.
 * - Ultra: High plus screen-space global illumination (one diffuse bounce of on-screen light).
 */
export function createPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  quality: Quality,
): Pipeline {
  const scope = createDisposalScope()
  try {
    const pipeline = scope.own(new RenderPipeline(renderer))
    pipeline.outputColorTransform = false
    let resetHistory = () => {}
    let width = 0,
      height = 0
    const result = (settleFrames: number): Pipeline => ({
      render() {
        const state = RendererUtils.saveRendererState(renderer)
        const xr = renderer.xr.enabled
        const perspective = camera as PerspectiveCamera
        const view = perspective.view ? { ...perspective.view } : null
        try {
          pipeline.render()
        } finally {
          RendererUtils.restoreRendererState(renderer, state)
          renderer.xr.enabled = xr
          if (perspective.isPerspectiveCamera) {
            perspective.view = view
            perspective.updateProjectionMatrix()
          }
        }
      },
      dispose: () => scope.dispose(),
      resetHistory: () => resetHistory(),
      resize(w, h) {
        if (w !== width || h !== height) {
          width = w
          height = h
          resetHistory()
        }
      },
      settleFrames,
    })

    if (quality === 'lite') {
      const scenePass = scope.own(pass(scene, camera, { samples: 4 }))
      pipeline.outputNode = finish(scenePass)
      return result(1)
    }

    // Opaque geometry only: glazing must not occlude the interior in AO, GI, or reprojection.
    const prePass = scope.own(pass(scene, camera))
    prePass.transparent = false
    prePass.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }))
    prePass.getTexture('output').type = UnsignedByteType
    const preDepth = prePass.getTextureNode('depth')
    const preVelocity = prePass.getTextureNode('velocity')
    const preNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)))

    const occlusion = scope.own(ao(preDepth, preNormal, camera))
    occlusion.useTemporalFiltering = true
    occlusion.resolutionScale = 0.5
    occlusion.radius.value = 0.9
    occlusion.thickness.value = 1.2
    occlusion.distanceExponent.value = 1.5
    occlusion.samples.value = 16

    const scenePass = scope.own(pass(scene, camera))
    scenePass.contextNode = builtinAOContext(occlusion.getTextureNode().sample(screenUV).r)
    scenePass.setMRT(
      mrt(quality === 'ultra' ? { output, emissive, diffuseColor } : { output, emissive }),
    )
    const color = scenePass.getTextureNode('output')
    const glow = scope.own(bloom(scenePass.getTextureNode('emissive'), 0.55, 0.45, 0.05))

    let lit: Node<'vec4'> = color.add(vec4(glow.rgb, 0))
    if (quality === 'ultra') {
      const diffuseTexture = scenePass.getTexture('diffuseColor')
      diffuseTexture.type = UnsignedByteType
      const gi = scope.own(ssgi(color, preDepth, preNormal, camera as PerspectiveCamera))
      gi.useTemporalFiltering = true
      gi.sliceCount.value = 2
      gi.stepCount.value = 10
      gi.radius.value = 6
      gi.thickness.value = 0.6
      gi.giIntensity.value = 1.4
      const bounce = scenePass.getTextureNode('diffuseColor').rgb.mul(gi.getGINode().rgb)
      lit = lit.add(vec4(bounce, 0))
    }

    // traa() converts a compound node to RTT internally but does not own/dispose that RTT.
    const beauty = scope.own(rtt(lit))
    const resolved = scope.own(traa(beauty, preDepth, preVelocity, camera))
    // r186 restarts history on a size mismatch; no public reset method exists.
    resetHistory = () =>
      (resolved as typeof resolved & { setSize(w: number, h: number): void }).setSize(1, 1)
    pipeline.outputNode = finish(resolved)
    // `?debug=ao` shows the occlusion buffer for tuning.
    const debug = new URLSearchParams(window.location.search).get('debug')
    if (debug === 'ao')
      pipeline.outputNode = vec4(vec3(occlusion.getTextureNode().sample(screenUV).r), 1)
    if (debug === 'normal')
      pipeline.outputNode = vec4(prePass.getTextureNode().sample(screenUV).rgb, 1)
    return result(quality === 'ultra' ? 40 : 28)
  } catch (error) {
    try {
      scope.dispose()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Pipeline setup and cleanup failed')
    }
    throw error
  }
}
