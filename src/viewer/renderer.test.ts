import { describe, expect, it, vi } from 'vitest'
import type { WebGPURenderer } from 'three/webgpu'
import { beginFrame, shareInstancedShaders, stopIdleLoop } from './renderer'

function fakeRenderer() {
  const nodeFrame = { frameId: 0, update: vi.fn(() => nodeFrame.frameId++) }
  const renderer = {
    _animation: { stop: vi.fn() },
    _nodes: { nodeFrame },
    info: { autoReset: true, frame: 0, reset: vi.fn() },
  }
  return { renderer, asRenderer: renderer as unknown as WebGPURenderer, nodeFrame }
}

describe('demand-driven renderer frames', () => {
  it('stops the idle loop and advances node state once per drawn frame', () => {
    const { renderer, asRenderer, nodeFrame } = fakeRenderer()
    stopIdleLoop(asRenderer)
    expect(renderer._animation.stop).toHaveBeenCalledTimes(1)
    beginFrame(asRenderer)
    beginFrame(asRenderer)
    expect(nodeFrame.update).toHaveBeenCalledTimes(2)
    expect(renderer.info.reset).toHaveBeenCalledTimes(2)
    expect(renderer.info.frame).toBe(2)
  })

  it('leaves three in charge if its internals change shape', () => {
    const { renderer, asRenderer, nodeFrame } = fakeRenderer()
    const changed = { ...renderer, _nodes: {} } as unknown as WebGPURenderer
    stopIdleLoop(changed)
    expect(renderer._animation.stop).not.toHaveBeenCalled()
    beginFrame(changed)
    beginFrame(asRenderer)
    expect(nodeFrame.update).not.toHaveBeenCalled()
  })
})

describe('instanced meshes', () => {
  it('take their matrices from vertex attributes, which shared shaders can read', () => {
    const capabilities = { getUniformBufferLimit: () => 65536 }
    shareInstancedShaders({
      backend: { isWebGPUBackend: true, capabilities },
    } as unknown as WebGPURenderer)
    expect(capabilities.getUniformBufferLimit()).toBe(0)
    expect(() =>
      shareInstancedShaders({ backend: { isWebGPUBackend: true } } as unknown as WebGPURenderer),
    ).not.toThrow()
  })

  it('keep per-mesh uniform blocks on WebGL, where they are freed with the mesh', () => {
    const capabilities = { getUniformBufferLimit: () => 65536 }
    shareInstancedShaders({ backend: { capabilities } } as unknown as WebGPURenderer)
    expect(capabilities.getUniformBufferLimit()).toBe(65536)
  })
})
