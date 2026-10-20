import { Texture } from 'three/webgpu'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceView } from '../render/pathtrace'
import { createProgressivePresentation } from './presentation'

const mocks = vi.hoisted(() => ({
  loads: [] as { value: unknown }[],
  render: vi.fn(),
}))
vi.mock('three/tsl', async (original) => {
  const tsl = await original<typeof import('three/tsl')>()
  return {
    ...tsl,
    textureLoad: (...args: Parameters<typeof tsl.textureLoad>) => {
      const node = tsl.textureLoad(...args)
      mocks.loads.push(node)
      return node
    },
  }
})
vi.mock('three/webgpu', async (original) => {
  const webgpu = await original<typeof import('three/webgpu')>()
  return {
    ...webgpu,
    RenderPipeline: class {
      outputColorTransform = true
      outputNode: unknown = null
      render = mocks.render
      dispose() {}
    },
  }
})
vi.mock('../render/pipeline', () => ({
  stillFinish: (node: unknown) => ({ output: node, glow: { dispose() {} } }),
}))

const image = (width: number, height: number) => {
  const texture = new Texture()
  texture.image = { width, height }
  return texture
}

describe('progressive presentation bindings (not a pixel test)', () => {
  beforeEach(() => {
    mocks.loads.length = 0
    mocks.render.mockClear()
  })
  const renderer = { toneMappingExposure: 1.2 } as never

  it('never builds the shader with the outgoing and incoming taps on one image', () => {
    const present = createProgressivePresentation(renderer)
    const outgoing = mocks.loads.slice(0, 4)
    const incoming = mocks.loads.slice(4, 8)
    expect(mocks.loads).toHaveLength(8)
    const first = image(640, 400)
    // The first image fades in from the raster: nothing is outgoing yet.
    present.render({ from: null, to: first, t: 0.3 } satisfies TraceView)
    for (const node of incoming) expect(node.value).toBe(first)
    for (const node of outgoing) expect(node.value).not.toBe(first)
    // A later milestone fades from the image on screen to the next one.
    const next = image(640, 400)
    present.render({ from: first, to: next, t: 0.5 })
    for (const node of outgoing) expect(node.value).toBe(first)
    for (const node of incoming) expect(node.value).toBe(next)
    present.render({ from: null, to: next, t: 1 })
    for (const node of outgoing) expect(node.value).not.toBe(next)
    expect(mocks.render).toHaveBeenCalledTimes(3)
    present.dispose()
  })
})
