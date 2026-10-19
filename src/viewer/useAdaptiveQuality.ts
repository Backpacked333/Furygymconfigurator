import { useCallback, useRef, useState } from 'react'
import { lower, tierMemory, type Verdict } from './governor'
import {
  defaultQuality,
  isConstrained,
  readDeviceSignals,
  requestedQuality,
  type Quality,
} from './quality'

export type QualityChange = { from: Quality; to: Quality; reason: 'slow' | 'fast' | 'remembered' }

/**
 * The tier to render at, owned by the app shell (no three.js import). It starts from the device
 * (Lite on phones, tablets, and low-end machines, High elsewhere), then follows the render
 * loop's governor: down when frames are slow, up to Ultra once when a device proves fast. Each
 * decision is remembered per GPU, so a returning visitor starts at the right tier. A tier chosen
 * by the user (or `?quality=`) is never overridden.
 */
export function useAdaptiveQuality(onChange?: (change: QualityChange) => void) {
  const device = useRef(readDeviceSignals())
  const pinned = useRef(requestedQuality() !== null)
  const [quality, setQuality] = useState<Quality>(() => defaultQuality(device.current))
  const gpu = useRef<string | null>(null)
  const settled = useRef(false)
  const current = useRef(quality)
  current.current = quality
  const report = useRef(onChange)
  report.current = onChange

  const apply = useCallback((to: Quality, reason: QualityChange['reason']) => {
    const from = current.current
    if (to === from) return
    current.current = to
    setQuality(to)
    report.current?.({ from, to, reason })
  }, [])

  /** The user picked a tier: theirs from now on. */
  const choose = useCallback((next: Quality) => {
    pinned.current = true
    current.current = next
    setQuality(next)
  }, [])

  /** Called with the GPU's name once a renderer exists: starts at the tier it settled on before. */
  const identify = useCallback(
    (key: string) => {
      gpu.current = key
      const saved = tierMemory.get(key)
      settled.current = saved !== null
      if (pinned.current || !saved) return
      if (saved === 'ultra' && isConstrained(device.current)) return
      apply(saved, 'remembered')
    },
    [apply],
  )

  /** The render loop's governor decided. */
  const verdict = useCallback(
    (v: Exclude<Verdict, null>) => {
      if (pinned.current) return
      const from = current.current
      const to = v === 'demote' ? lower(from) : 'ultra'
      if (to === from) return
      settled.current = true
      if (gpu.current) tierMemory.set(gpu.current, to)
      apply(to, v === 'demote' ? 'slow' : 'fast')
    },
    [apply],
  )

  // Promotion is tried once per device: never after a decision, never on constrained hardware.
  const promote =
    !pinned.current && !settled.current && quality === 'high' && !isConstrained(device.current)
  return { quality, choose, identify, verdict, promote }
}
