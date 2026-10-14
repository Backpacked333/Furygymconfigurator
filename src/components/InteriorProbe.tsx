import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PMREMGenerator, Vector3, type RenderTarget, type WebGPURenderer } from 'three/webgpu'
import { productHeight, type Config } from '../lib/config'
import { onMaterialsChanged, setInteriorEnvironment } from '../render/materials'
import type { Quality } from '../render/renderer'

/**
 * Interior image-based lighting. A radiance cube is captured from the middle of the room and used
 * as the environment for interior surfaces, so walls, floor, and equipment are lit and reflected
 * by the room itself (light through the glazing, luminaires, finishes) rather than the open sky.
 * Two captures per change approximate a second diffuse bounce; targets ping-pong so a probe is
 * never sampled while it is being written.
 */
export function InteriorProbe({ config, quality }: { config: Config; quality: Quality }) {
  const { gl, scene, invalidate } = useThree()
  const renderer = gl as unknown as WebGPURenderer
  const state = useRef<{
    generator: PMREMGenerator
    targets: (RenderTarget | null)[]
    current: number
    passes: number
    wait: number
  } | null>(null)
  const center = useRef(new Vector3())
  center.current.set(0, productHeight(config) * 0.52, 0.3)

  useEffect(() => {
    state.current = {
      generator: new PMREMGenerator(renderer),
      targets: [null, null],
      current: 0,
      passes: 0,
      wait: 0,
    }
    return () => {
      setInteriorEnvironment(null)
      state.current?.targets.forEach((t) => t?.dispose())
      state.current?.generator.dispose()
      state.current = null
    }
  }, [renderer])

  // Re-capture after any configuration or lighting change, once textures settle.
  useEffect(() => {
    if (!state.current) return
    state.current.passes = 2
    state.current.wait = 2
    invalidate()
  }, [config, quality, invalidate])
  useEffect(
    () =>
      onMaterialsChanged((change) => {
        if (change !== 'textures' || !state.current || state.current.passes > 0) return
        state.current.passes = 2
        state.current.wait = 4
      }),
    [],
  )

  useFrame(() => {
    const probe = state.current
    if (!probe || probe.passes <= 0) return
    if (probe.wait > 0) {
      probe.wait--
      invalidate()
      return
    }
    const next = 1 - probe.current
    const target = probe.generator.fromScene(scene, 0, 0.05, 400, {
      size: quality === 'lite' ? 64 : 128,
      position: center.current,
      renderTarget: probe.targets[next] ?? undefined,
    })
    probe.targets[next] = target
    probe.current = next
    probe.passes--
    setInteriorEnvironment(target.texture)
    invalidate()
  }, 0)
  return null
}
