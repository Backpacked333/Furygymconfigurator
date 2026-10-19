import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import type { WebGPURenderer } from 'three/webgpu'
import { sceneProgress } from './progress'
import type { Quality } from './quality'
import { createRenderer } from './renderer'
import { Tier } from './tierContext'
import { TIERS, type TierSpec } from './tiers'

/** Renderer rebuilds after device loss before the viewer gives up and shows its fallback. */
const MAX_RENDERER_REBUILDS = 3
function DeviceUnstable(): never {
  throw new Error('The graphics device keeps getting lost.')
}

class GraphicsBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onFailure()
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Sets the tier for content rendered outside a `<Viewer>` (an offline still renderer). */
export function TierProvider({
  quality,
  spec = TIERS[quality],
  children,
}: {
  quality: Quality
  spec?: TierSpec
  children: ReactNode
}) {
  return <Tier.Provider value={{ quality, spec }}>{children}</Tier.Provider>
}

/**
 * The canvas: a WebGPU renderer (WebGL 2 fallback) at the tier's pixel ratio, rendering on demand
 * and only while `active`. A lost GPU device (driver reset, GPU process crash, the OS reclaiming
 * memory) rebuilds the renderer on WebGL 2, a few times per session; past that, or when no 3D
 * backend exists at all, `fallback` shows and `onUnavailable` fires.
 */
export function Viewer({
  active = true,
  quality,
  spec = TIERS[quality],
  prepare,
  onRenderer,
  onUnavailable,
  fallback = null,
  camera = { position: [30, 18, 35], fov: 34, near: 0.1, far: 2000 },
  children,
}: {
  /** False while hidden: nothing renders until the viewer shows again. */
  active?: boolean
  quality: Quality
  spec?: TierSpec
  /** Product setup to finish, alongside renderer start-up, before the first frame. */
  prepare?: () => Promise<unknown> | void
  /** The new renderer, before its first frame. */
  onRenderer?: (renderer: WebGPURenderer) => void
  onUnavailable?: () => void
  fallback?: ReactNode
  camera?: { position: [number, number, number]; fov: number; near: number; far: number }
  children: ReactNode
}) {
  const [generation, setGeneration] = useState(0)
  // The viewer may stay mounted while hidden, so showing it again starts a fresh attempt after a
  // failure instead of leaving the fallback up for good.
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(active)
  if (active !== shown) {
    setShown(active)
    if (active && (failed || generation > MAX_RENDERER_REBUILDS)) {
      setFailed(false)
      setGeneration(0)
      setAttempt(attempt + 1)
    }
  }
  // The renderer that is mounted, or null while the viewer is torn down.
  const mounted = `${attempt}:${generation}`
  const live = useRef<string | null>(null)
  useEffect(() => {
    live.current = mounted
    return () => {
      live.current = null
    }
  }, [mounted])
  return (
    <GraphicsBoundary
      key={attempt}
      fallback={fallback}
      onFailure={() => {
        setFailed(true)
        onUnavailable?.()
      }}
    >
      {generation > MAX_RENDERER_REBUILDS ? (
        <DeviceUnstable />
      ) : (
        <Canvas
          key={generation}
          shadows="percentage"
          // Never the full Retina density: temporal AA resolves edges, and pixels are the cost.
          dpr={[1, spec.dpr]}
          frameloop={active ? 'demand' : 'never'}
          camera={camera}
          gl={async ({ canvas }) => {
            sceneProgress.set('renderer')
            // Only the live renderer recovers, never one that is being torn down.
            const rebuild = () => {
              if (live.current === mounted) setGeneration(generation + 1)
            }
            // R3F renders nothing until this factory resolves.
            const [renderer] = await Promise.all([
              // After a lost device, rebuild on WebGL 2: a WebGPU device that was lost once (a driver
              // reset, the browser reclaiming memory) tends to be lost again.
              createRenderer(canvas as HTMLCanvasElement, { forceWebGL: generation > 0 }).then(
                (renderer) => {
                  // Watch for loss as soon as the renderer exists, not after the product's setup.
                  const report = renderer.onDeviceLost
                  renderer.onDeviceLost = (info) => {
                    report.call(renderer, info)
                    rebuild()
                  }
                  return renderer
                },
              ),
              prepare?.(),
            ])
            // Lost while it was still being set up, before anything listened.
            if ((renderer as unknown as { _isDeviceLost?: boolean })._isDeviceLost) rebuild()
            // The first frame compiles every shader in view.
            sceneProgress.set('shaders')
            onRenderer?.(renderer)
            return renderer
          }}
        >
          <Tier.Provider value={{ quality, spec }}>{children}</Tier.Provider>
        </Canvas>
      )}
    </GraphicsBoundary>
  )
}
