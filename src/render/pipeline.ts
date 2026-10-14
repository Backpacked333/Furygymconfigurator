import {
  FloatType,
  MeshBasicNodeMaterial,
  QuadMesh,
  RenderPipeline,
  RenderTarget,
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
  diffuseColor,
  emissive,
  float,
  interleavedGradientNoise,
  ivec2,
  log,
  luminance,
  max,
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
  texture,
  textureLoad,
  uniform,
  unpackRGBToNormal,
  uv,
  vec3,
  vec4,
  velocity,
} from 'three/tsl'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ssgi } from 'three/addons/tsl/display/SSGINode.js'
import { traa } from 'three/addons/tsl/display/TRAANode.js'
import type { Quality } from './renderer'

export type Pipeline = {
  render: () => void
  dispose: () => void
  /** Frames to keep rendering after a change so temporal AA, AO, and GI converge. */
  settleFrames: number
  /** The latest linear HDR frame, before finishing; it holds still while nothing renders. */
  hdr: Texture
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
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const disposables: { dispose: () => void }[] = [pipeline]

  if (quality === 'lite') {
    const scenePass = pass(scene, camera, { samples: 4 })
    pipeline.outputNode = finish(scenePass)
    return {
      render: () => pipeline.render(),
      dispose: () => pipeline.dispose(),
      settleFrames: 1,
      hdr: scenePass.getTexture('output'),
    }
  }

  // Opaque geometry only: glazing must not occlude the interior in AO, GI, or reprojection.
  const prePass = pass(scene, camera)
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
  occlusion.samples.value = 16
  disposables.push(occlusion)

  const scenePass = pass(scene, camera)
  scenePass.contextNode = builtinAOContext(occlusion.getTextureNode().sample(screenUV).r)
  scenePass.setMRT(
    mrt(quality === 'ultra' ? { output, emissive, diffuseColor } : { output, emissive }),
  )
  const color = scenePass.getTextureNode('output')
  const glow = bloom(scenePass.getTextureNode('emissive'), 0.55, 0.45, 0.05)
  disposables.push(glow)

  let lit: Node<'vec4'> = color.add(vec4(glow.rgb, 0))
  if (quality === 'ultra') {
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
    settleFrames: quality === 'ultra' ? 40 : 28,
    hdr: (resolved as unknown as { getTextureNode: () => { value: Texture } }).getTextureNode()
      .value,
  }
}

export type TracePresent = {
  /** Composites the traced images over the frozen raster frame and finishes them. */
  render: (view: { from: Texture | null; to: Texture; t: number; gain: number }) => void
  dispose: () => void
}

/**
 * Presents path-traced images with the same finishing as the raster image. `from` (or, when it is
 * null, the frozen raster frame) blends into `to`, so every change of image reads as the picture
 * settling rather than a cut. Bright highlights (lamps, sun glints) get a faint lens bloom, as a
 * camera would record them.
 */
export function createTracePresent(
  renderer: WebGPURenderer,
  raster: Texture,
  traced: Texture,
): TracePresent {
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const t = uniform(0)
  const fromRaster = uniform(1)
  const size = uniform(new Vector2(1, 1))
  // Traced images are unfilterable float with rows top down, like screen coordinates.
  const gain = uniform(1)
  const pixel = ivec2(screenUV.mul(size).floor())
  const from = textureLoad(traced, pixel)
  const to = textureLoad(traced, pixel)
  const before = mix(vec4(from.rgb.mul(gain), 1), texture(raster), fromRaster)
  const after = vec4(to.rgb.mul(gain), 1)
  const glow = bloom(after, 0.16, 0.5, 1.4)
  const image = mix(before, after.add(vec4(glow.rgb, 0)), t)
  pipeline.outputNode = finish(image)
  return {
    render: (view) => {
      to.value = view.to
      from.value = view.from ?? view.to
      fromRaster.value = view.from ? 0 : 1
      const { width, height } = view.to.image as { width: number; height: number }
      size.value.set(width, height)
      t.value = view.t
      gain.value = view.gain
      pipeline.render()
    },
    dispose: () => {
      glow.dispose()
      pipeline.dispose()
    },
  }
}

/**
 * Matrix metering for HDR images: the log-average luminance over a coarse grid, as a camera
 * meters a scene. Used to hand over from the raster frame to the traced one without a jump in
 * brightness: the traced image keeps the exposure the viewer was looking at, while its light
 * distribution (occlusion, bounce, sky visibility) stays physically resolved.
 */
export function createExposureMeter(renderer: WebGPURenderer, sample: Texture) {
  const width = 48,
    height = 30
  const target = new RenderTarget(width, height, { type: FloatType, depthBuffer: false })
  const size = uniform(new Vector2(1, 1))
  // Material output is clamped to non-negative values, so store the log luminance offset.
  const OFFSET = 10
  const logLuminance = (color: Node<'vec4'>) =>
    vec4(log(max(luminance(color.rgb), float(1e-4))).add(OFFSET), 0, 0, 1)
  // Raster frames are filterable; traced images are unfilterable float and read texel by texel.
  const rasterNode = texture(sample, uv())
  const tracedNode = textureLoad(sample, ivec2(uv().mul(size).floor()))
  const rasterMaterial = new MeshBasicNodeMaterial()
  rasterMaterial.colorNode = logLuminance(rasterNode)
  const tracedMaterial = new MeshBasicNodeMaterial()
  tracedMaterial.colorNode = logLuminance(tracedNode)
  const quad = new QuadMesh(rasterMaterial)
  return {
    /** Mean log luminance of `image`; `traced` selects texel reads for unfilterable floats. */
    async measure(image: Texture, traced: boolean) {
      const material = traced ? tracedMaterial : rasterMaterial
      if (traced) {
        tracedNode.value = image
        const { width: w, height: h } = image.image as { width: number; height: number }
        size.value.set(w, h)
      } else rasterNode.value = image
      quad.material = material
      const previous = renderer.getRenderTarget()
      renderer.setRenderTarget(target)
      quad.render(renderer)
      renderer.setRenderTarget(previous)
      const pixels = (await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
      )) as Float32Array
      const stride = pixels.length / height
      let sum = 0
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) sum += pixels[y * stride + x * 4]
      return sum / (width * height) - OFFSET
    },
    dispose() {
      target.dispose()
      rasterMaterial.dispose()
      tracedMaterial.dispose()
    },
  }
}
