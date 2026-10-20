import {
  FloatType,
  RenderPipeline,
  RenderTarget,
  RGBAFormat,
  StorageTexture,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu'
import { clamp, ivec2, mix, screenUV, texture, textureLoad, uniform, vec2, vec4 } from 'three/tsl'
import { stillFinish } from '../render/pipeline'
import type { TraceView } from '../render/pathtrace'

/** Keep the finished raster visible until a denoised, current-revision trace is ready. */
export function createProgressivePresentation(renderer: WebGPURenderer) {
  const raster = new RenderTarget(1, 1, { depthBuffer: false })
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const size = uniform(new Vector2(1, 1))
  const blend = uniform(0)
  const fromRaster = uniform(1)
  const exposure = uniform(1)
  // What the outgoing taps read while nothing fades out. Texture nodes holding the same texture
  // when the shader is built share one binding for good, so the outgoing and incoming taps must
  // never hold the same image then: if they did, every later fade would read the outgoing image
  // on both sides and the incoming one would cut in at its end. Weighted out whenever it is bound.
  const none = new StorageTexture(1, 1)
  none.type = FloatType
  none.format = RGBAFormat
  none.generateMipmaps = false
  // Bilinear by hand: the traced images are float storage textures, which need not be filterable.
  // A trace at the canvas's own size samples each texel exactly; a reduced-scale trace (Lite at
  // half; High and Ultra past the Cycles image's pixels or under ?traceScale: liveProfile.ts
  // traceScale) is filtered up instead of shown as blocks.
  const at = screenUV.mul(size).sub(0.5)
  const base = at.floor()
  const f = at.sub(base)
  const last = size.sub(1)
  const taps = (nodes: ReturnType<typeof textureLoad>[]) => {
    const [a, b, c, d] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([x, y]) => {
      const node = textureLoad(raster.texture, ivec2(clamp(base.add(vec2(x, y)), vec2(0), last)))
      nodes.push(node)
      return node
    })
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y)
  }
  const from: ReturnType<typeof textureLoad>[] = []
  const to: ReturnType<typeof textureLoad>[] = []
  const hdr = mix(taps(from), taps(to), fromRaster.equal(1).select(1, blend))
  const finished = stillFinish(vec4(hdr.rgb, 1), exposure)
  pipeline.outputNode = mix(
    texture(raster.texture),
    finished.output,
    fromRaster.equal(1).select(blend, 1),
  )
  return {
    capture(draw: () => void) {
      const size = renderer.getDrawingBufferSize(new Vector2())
      raster.setSize(size.x, size.y)
      const previous = renderer.getRenderTarget()
      try {
        renderer.setRenderTarget(raster)
        draw()
      } finally {
        renderer.setRenderTarget(previous)
      }
    },
    render(view: TraceView) {
      for (const node of from) node.value = view.from ?? none
      for (const node of to) node.value = view.to
      const image = view.to.image as { width: number; height: number }
      size.value.set(image.width, image.height)
      blend.value = view.t
      fromRaster.value = view.from ? 0 : 1
      exposure.value = renderer.toneMappingExposure
      pipeline.render()
    },
    dispose() {
      finished.glow.dispose()
      pipeline.dispose()
      raster.dispose()
      none.dispose()
    },
  }
}
