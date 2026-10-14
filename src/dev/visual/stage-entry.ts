import { AgXToneMapping, SRGBColorSpace, Vector2 } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { createNeutralStage, type StageSwatch } from './neutralStage'

async function start() {
  if (!import.meta.env.DEV) throw new Error('Neutral stage is development-only')
  const canvas = document.querySelector<HTMLCanvasElement>('#stage')!
  const status = document.querySelector<HTMLElement>('#status')!
  const query = new URLSearchParams(location.search)
  const requested = query.get('backend') === 'webgpu' ? 'webgpu' : 'webgl2'
  const profile = query.get('light') === 'warm' ? 'warm' : 'day'
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: requested === 'webgl2',
  })
  await renderer.init().catch((error) => {
    renderer.dispose()
    throw error
  })
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = 1
  renderer.outputColorSpace = SRGBColorSpace
  renderer.shadowMap.enabled = true
  const swatches: StageSwatch[] = []
  let unsubscribe: (() => void) | undefined
  let assetState = 'Synthetic stage — no downloaded maps'
  let disposed = false
  let dirty = false
  let rendering = false
  if (query.get('materials') === 'production') {
    const { material, textureMaps, onMaterialsChanged } = await import('../../render/materials')
    const specs = [
      { set: 'rubber_tiles' },
      { set: 'oak_veneer_01' },
      { set: 'beige_wall_001' },
      { set: 'brushed_metal', metalness: 1 },
      { set: 'powder_coat', color: '#262927', roughness: 0.48, normalScale: 0.3 },
      { set: 'leather_white', color: '#343434', roughness: 0.78 },
    ] as const
    status.textContent = 'Loading production maps — not settled'
    const outcomes = await Promise.allSettled(specs.map((spec) => textureMaps(spec.set)))
    const failed = outcomes.filter((result) => result.status === 'rejected').length
    // At the baseline, creating a material before its failed map settles can reject unhandled.
    specs.forEach((spec, index) => {
      if (outcomes[index].status === 'fulfilled')
        swatches.push({ name: spec.set, material: material(spec) })
    })
    assetState = failed
      ? `Degraded — ${failed} material sets failed and are omitted from comparison`
      : 'Production maps resolved — inspect response, not an approval'
    unsubscribe = onMaterialsChanged(() => {
      dirty = true
    })
  }
  const stage = createNeutralStage(profile, swatches)
  function resize() {
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, Math.round((width * 9) / 16))
    const dpr = query.get('dpr') === '2' ? 2 : 1
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)
    stage.camera.aspect = width / height
    stage.camera.updateProjectionMatrix()
    dirty = true
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()
  // Poll dirty state only; settled stages do not submit new frames.
  renderer.setAnimationLoop(async () => {
    if (!dirty || rendering || disposed) return
    dirty = false
    rendering = true
    try {
      await renderer.renderAsync(stage.scene, stage.camera)
      if (disposed) return
      const size = renderer.getDrawingBufferSize(new Vector2())
      const actual =
        'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend
          ? 'webgpu'
          : 'webgl2'
      status.textContent = `${actual} (requested ${requested}) · ${profile} · ${size.x}×${size.y} rendered pixels\n${assetState}`
    } catch (error) {
      status.textContent = `Stage render failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      rendering = false
    }
  })
  window.addEventListener(
    'pagehide',
    () => {
      disposed = true
      renderer.setAnimationLoop(null)
      observer.disconnect()
      unsubscribe?.()
      stage.dispose()
      renderer.dispose()
    },
    { once: true },
  )
}

void start().catch((error) => {
  const status = document.querySelector<HTMLElement>('#status')
  if (status)
    status.textContent = `Stage unavailable: ${error instanceof Error ? error.message : String(error)}`
})
