import { RenderPipeline, RenderTarget, Vector2, type WebGPURenderer } from 'three/webgpu'
import { ivec2, mix, screenUV, texture, textureLoad, uniform, vec4 } from 'three/tsl'
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
  const pixel = ivec2(screenUV.mul(size).floor())
  const from = textureLoad(raster.texture, pixel)
  const to = textureLoad(raster.texture, pixel)
  const hdr = mix(from, to, blend)
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
      from.value = view.from ?? view.to
      to.value = view.to
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
    },
  }
}
